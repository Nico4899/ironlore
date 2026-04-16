import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  detectPageType,
  extractableFormat,
  isSupportedExtension,
  type PageType,
  parseBlocks,
} from "@ironlore/core";
import { extract } from "@ironlore/core/extractors";
import Database from "better-sqlite3";

/**
 * Wiki-link patterns in markdown:
 *   [[Page Name]]              — wikilink
 *   [[Page Name#blk_...]]      — block reference
 *   [[Page Name | relation]]   — typed relation (optional pipe form)
 *   ![[Page Name]]             — embed
 *   @[[Page Name]]             — mention
 *
 * The typed relation form `[[target | rel]]` stores the optional
 * `rel` column in the backlinks table. See
 * docs/01-content-model.md §Wiki-link relations.
 */
const WIKILINK_RE = /(?:!|@)?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\s*\|\s*([a-z][a-z0-9_]*))?\]\]/g;

/**
 * Extract title from the first H1 heading in markdown, falling back to path.
 */
function extractTitle(markdown: string, pagePath: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() ?? pagePath;
}

/**
 * Extract tags from YAML frontmatter (simple line-based parse).
 * Supports `tags: [a, b]` and multi-line `tags:\n  - a\n  - b`.
 */
function extractTags(markdown: string): string[] {
  if (!markdown.startsWith("---")) return [];
  const endIdx = markdown.indexOf("\n---", 3);
  if (endIdx === -1) return [];
  const frontmatter = markdown.slice(4, endIdx);

  // Single-line: tags: [a, b, c]
  const inlineMatch = /^tags:\s*\[([^\]]*)\]/m.exec(frontmatter);
  if (inlineMatch?.[1]) {
    return inlineMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  // Multi-line: tags:\n  - a\n  - b
  const lines = frontmatter.split("\n");
  const tagsIdx = lines.findIndex((l) => /^tags:\s*$/.test(l));
  if (tagsIdx === -1) return [];

  const tags: string[] = [];
  for (let i = tagsIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const itemMatch = /^\s+-\s+(.+)/.exec(line);
    if (itemMatch?.[1]) {
      tags.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
    } else {
      break;
    }
  }
  return tags;
}

export interface WikiLink {
  target: string;
  /** Optional relation type from the `[[target | rel]]` pipe form. */
  rel: string | null;
}

/**
 * Extract wiki-link targets from markdown content.
 * Returns deduplicated target page names with optional relation types.
 */
export function extractWikiLinks(markdown: string): WikiLink[] {
  const seen = new Map<string, WikiLink>();
  for (const match of markdown.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (!target) continue;
    const rel = match[2]?.trim() ?? null;
    // If we've already seen this target, prefer the version with a rel.
    const existing = seen.get(target);
    if (!existing || (rel && !existing.rel)) {
      seen.set(target, { target, rel });
    }
  }
  return [...seen.values()];
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface BacklinkEntry {
  sourcePath: string;
  linkText: string;
}

/**
 * Derived search index backed by `.ironlore/index.sqlite`.
 *
 * Contains:
 * - FTS5 full-text search over page content
 * - Backlinks table (wiki-link cross-references)
 * - Tags extracted from frontmatter
 * - Recent-edits tracking
 *
 * Rebuilt incrementally on every page write. Can be fully regenerated
 * from `data/` via `reindexAll()`.
 */
export class SearchIndex {
  private db: Database.Database;

  constructor(projectDir: string) {
    const ironloreDir = join(projectDir, ".ironlore");
    mkdirSync(ironloreDir, { recursive: true });
    const dbPath = join(ironloreDir, "index.sqlite");

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        path,
        title,
        content
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backlinks (
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        link_text   TEXT NOT NULL,
        rel         TEXT,
        PRIMARY KEY (source_path, target_path, link_text)
      )
    `);

    // Migration: add `rel` column to existing backlinks tables that
    // were created before typed wiki-links shipped (Track C Step 4).
    try {
      this.db.exec("ALTER TABLE backlinks ADD COLUMN rel TEXT");
    } catch {
      // Column already exists — expected on databases created after the change.
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_backlinks_target
      ON backlinks(target_path)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        path TEXT NOT NULL,
        tag  TEXT NOT NULL,
        PRIMARY KEY (path, tag)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tags_tag
      ON tags(tag)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recent_edits (
        path       TEXT NOT NULL PRIMARY KEY,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        author     TEXT NOT NULL DEFAULT 'user'
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        path       TEXT NOT NULL PRIMARY KEY,
        name       TEXT NOT NULL,
        parent     TEXT,
        file_type  TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pages_parent
      ON pages(parent)
    `);

    // Chunk-level FTS5 — ~800-token chunks split at block-ID seams.
    // Enables paragraph-level search results with block-ID citations
    // ([[page#blk_...]]) instead of page-level matches. Additive to
    // pages_fts; rollback is DROP TABLE pages_chunks_fts.
    // See docs/02-storage-and-sync.md §Derived indexes.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_chunks_fts USING fts5(
        path,
        chunk_idx,
        block_id_start,
        block_id_end,
        content
      )
    `);
  }

  /**
   * Index a page after a write. Replaces any existing entry for this path.
   */
  indexPage(pagePath: string, content: string, author: string): void {
    const title = extractTitle(content, pagePath);
    const tags = extractTags(content);
    const links = extractWikiLinks(content);

    const txn = this.db.transaction(() => {
      // FTS5 page-level: delete old, insert new
      this.db.prepare("DELETE FROM pages_fts WHERE path = ?").run(pagePath);
      this.db
        .prepare("INSERT INTO pages_fts (path, title, content) VALUES (?, ?, ?)")
        .run(pagePath, title, content);

      // FTS5 chunk-level: split at block-ID boundaries, ~800 tokens per chunk.
      this.db.prepare("DELETE FROM pages_chunks_fts WHERE path = ?").run(pagePath);
      const blocks = parseBlocks(content);
      if (blocks.length > 0) {
        const insertChunk = this.db.prepare(
          `INSERT INTO pages_chunks_fts (path, chunk_idx, block_id_start, block_id_end, content)
           VALUES (?, ?, ?, ?, ?)`,
        );
        let chunkIdx = 0;
        let chunkText = "";
        let chunkStartId = blocks[0]?.id ?? "";
        let chunkEndId = chunkStartId;

        for (const block of blocks) {
          const blockTokens = block.text.length / 4; // rough token estimate
          if (chunkText.length > 0 && chunkText.length / 4 + blockTokens > 800) {
            // Flush the current chunk.
            insertChunk.run(pagePath, chunkIdx, chunkStartId, chunkEndId, chunkText);
            chunkIdx++;
            chunkText = "";
            chunkStartId = block.id;
          }
          chunkText += (chunkText ? "\n\n" : "") + block.text;
          chunkEndId = block.id;
        }
        // Flush the last chunk.
        if (chunkText) {
          insertChunk.run(pagePath, chunkIdx, chunkStartId, chunkEndId, chunkText);
        }
      }

      // Backlinks: delete old outgoing links, insert new (with optional rel).
      this.db.prepare("DELETE FROM backlinks WHERE source_path = ?").run(pagePath);
      const insertLink = this.db.prepare(
        "INSERT OR IGNORE INTO backlinks (source_path, target_path, link_text, rel) VALUES (?, ?, ?, ?)",
      );
      for (const link of links) {
        insertLink.run(pagePath, link.target, link.target, link.rel);
      }

      // Tags: delete old, insert new
      this.db.prepare("DELETE FROM tags WHERE path = ?").run(pagePath);
      const insertTag = this.db.prepare("INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)");
      for (const tag of tags) {
        insertTag.run(pagePath, tag);
      }

      // Recent edits
      this.db
        .prepare(
          `INSERT INTO recent_edits (path, updated_at, author) VALUES (?, datetime('now'), ?)
         ON CONFLICT(path) DO UPDATE SET updated_at = datetime('now'), author = ?`,
        )
        .run(pagePath, author, author);
    });

    txn();

    // Update pages table (outside FTS transaction for simplicity)
    const fileType = detectPageType(pagePath);
    this.upsertPage(pagePath, fileType);
  }

  /**
   * Remove a page from the index (after deletion).
   */
  removePage(pagePath: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pages_fts WHERE path = ?").run(pagePath);
      this.db.prepare("DELETE FROM backlinks WHERE source_path = ?").run(pagePath);
      this.db.prepare("DELETE FROM tags WHERE path = ?").run(pagePath);
      this.db.prepare("DELETE FROM recent_edits WHERE path = ?").run(pagePath);
    });
    txn();

    this.deletePage(pagePath);
  }

  /**
   * Full-text search via FTS5. Returns results ranked by relevance.
   *
   * Each bare token is wrapped in double-quotes (to escape FTS operators)
   * and suffixed with `*` for prefix matching — so typing "carou" matches
   * "carousel". Empty queries short-circuit to an empty result.
   */
  search(query: string, limit = 20): SearchResult[] {
    const tokens = query
      .split(/\s+/)
      .map((t) => t.replace(/"/g, ""))
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((t) => `"${t}"*`).join(" ");

    // Stage 1: page-level FTS5
    const pageResults = this.db
      .prepare(
        `SELECT path, title, snippet(pages_fts, 2, '<mark>', '</mark>', '…', 32) AS snippet,
                rank
         FROM pages_fts
         WHERE pages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit * 2) as SearchResult[];

    // Stage 2: chunk-level FTS5 — block-ID citations
    const chunkResults = this.db
      .prepare(
        `SELECT path,
                snippet(pages_chunks_fts, 4, '<mark>', '</mark>', '…', 32) AS snippet,
                block_id_start AS blockIdStart,
                block_id_end AS blockIdEnd,
                rank
         FROM pages_chunks_fts
         WHERE pages_chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit * 2) as Array<
      SearchResult & { blockIdStart?: string; blockIdEnd?: string }
    >;

    // RRF merge: combine page-level and chunk-level results.
    // Chunk results carry block-ID citations; page results have titles.
    const K = 60; // RRF constant
    const scoreMap = new Map<string, { score: number; result: SearchResult }>();

    for (let i = 0; i < pageResults.length; i++) {
      const r = pageResults[i];
      if (!r) continue;
      const key = r.path;
      const existing = scoreMap.get(key);
      const rrfScore = 1 / (K + i + 1);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, result: r });
      }
    }

    for (let i = 0; i < chunkResults.length; i++) {
      const r = chunkResults[i];
      if (!r) continue;
      const key = r.path;
      const existing = scoreMap.get(key);
      const rrfScore = 1 / (K + i + 1);
      if (existing) {
        existing.score += rrfScore;
        // Prefer chunk snippet (more precise) over page snippet.
        if (r.snippet) existing.result.snippet = r.snippet;
        if (r.blockIdStart) (existing.result as unknown as Record<string, unknown>).blockIdStart = r.blockIdStart;
        if (r.blockIdEnd) (existing.result as unknown as Record<string, unknown>).blockIdEnd = r.blockIdEnd;
      } else {
        scoreMap.set(key, {
          score: rrfScore,
          result: { path: r.path, title: r.title ?? r.path, snippet: r.snippet, rank: r.rank },
        });
      }
    }

    return [...scoreMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => e.result);
  }

  /**
   * Get all pages that link to the given target path or page name.
   */
  getBacklinks(targetPath: string): BacklinkEntry[] {
    return this.db
      .prepare(
        "SELECT source_path AS sourcePath, link_text AS linkText FROM backlinks WHERE target_path = ?",
      )
      .all(targetPath) as BacklinkEntry[];
  }

  /**
   * Get all outgoing links from a page.
   */
  getOutlinks(sourcePath: string): string[] {
    const rows = this.db
      .prepare("SELECT target_path FROM backlinks WHERE source_path = ?")
      .all(sourcePath) as Array<{ target_path: string }>;
    return rows.map((r) => r.target_path);
  }

  /**
   * Get pages by tag.
   */
  getPagesByTag(tag: string): string[] {
    const rows = this.db.prepare("SELECT path FROM tags WHERE tag = ?").all(tag) as Array<{
      path: string;
    }>;
    return rows.map((r) => r.path);
  }

  /**
   * Get recently edited pages.
   */
  getRecentEdits(limit = 20): Array<{ path: string; updatedAt: string; author: string }> {
    return this.db
      .prepare(
        `SELECT path, updated_at AS updatedAt, author
         FROM recent_edits ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ path: string; updatedAt: string; author: string }>;
  }

  /**
   * Full reindex from filesystem. Nukes all existing data and rebuilds.
   * Called by `ironlore reindex`.
   *
   * Markdown files are indexed inline. Extractable binaries (.docx /
   * .xlsx / .eml) are queued and processed asynchronously after the walk
   * so a slow extractor doesn't hold up tree population.
   */
  async reindexAll(dataRoot: string): Promise<{ indexed: number }> {
    // Clear all tables
    const clear = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pages_fts").run();
      this.db.prepare("DELETE FROM backlinks").run();
      this.db.prepare("DELETE FROM tags").run();
      this.db.prepare("DELETE FROM recent_edits").run();
      this.db.prepare("DELETE FROM pages").run();
    });
    clear();

    // Walk data directory and index all supported files
    let indexed = 0;
    const extractableQueue: Array<{ relPath: string; fullPath: string }> = [];
    const walk = (dir: string) => {
      let items: import("node:fs").Dirent[];
      try {
        items = readdirSync(dir, {
          withFileTypes: true,
          encoding: "utf-8",
        }) as import("node:fs").Dirent[];
      } catch {
        return;
      }
      for (const item of items) {
        if (item.name.startsWith(".") && item.name !== ".agents") continue;
        // Skip block-id sidecars (`foo.md.blocks.json`) — internal metadata.
        if (item.name.endsWith(".blocks.json")) continue;
        const fullPath = join(dir, item.name);
        const relPath = relative(dataRoot, fullPath);

        if (item.isDirectory()) {
          this.upsertPage(relPath, "directory");
          walk(fullPath);
        } else if (isSupportedExtension(item.name)) {
          const fileType = detectPageType(item.name);
          this.upsertPage(relPath, fileType);

          if (item.name.endsWith(".md")) {
            try {
              const content = readFileSync(fullPath, "utf-8");
              this.indexPage(relPath, content, "reindex");
            } catch {
              // Skip unreadable files
            }
          } else if (extractableFormat(item.name)) {
            extractableQueue.push({ relPath, fullPath });
          }
          indexed++;
        }
      }
    };

    walk(dataRoot);

    for (const { relPath, fullPath } of extractableQueue) {
      const format = extractableFormat(fullPath);
      if (!format) continue;
      try {
        const buffer = readFileSync(fullPath);
        const arrayBuffer = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        );
        const result = await extract(format, arrayBuffer);
        this.indexPage(relPath, result.text, "reindex");
      } catch (err) {
        console.warn(`FTS extractor failed during reindex for ${relPath}:`, err);
      }
    }

    return { indexed };
  }

  // -------------------------------------------------------------------------
  // Tree (pages table)
  // -------------------------------------------------------------------------

  /**
   * Insert or update a page entry in the pages table.
   * Also ensures all ancestor directories exist as entries.
   */
  upsertPage(pagePath: string, fileType: PageType | "directory"): void {
    const name = basename(pagePath);
    const parentDir = dirname(pagePath);
    const parent = parentDir === "." ? null : parentDir;

    // Ensure ancestor directories exist
    if (parent) {
      this.ensureDirectoryChain(parent);
    }

    this.db
      .prepare(
        `INSERT INTO pages (path, name, parent, file_type, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           parent = excluded.parent,
           file_type = excluded.file_type,
           updated_at = datetime('now')`,
      )
      .run(pagePath, name, parent, fileType);
  }

  /**
   * Ensure all directories in the chain exist as page entries.
   */
  private ensureDirectoryChain(dirPath: string): void {
    const parts = dirPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const parentDir = dirname(current);
      const parent = parentDir === "." ? null : parentDir;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pages (path, name, parent, file_type)
           VALUES (?, ?, ?, 'directory')`,
        )
        .run(current, part, parent);
    }
  }

  /**
   * Delete a page from the pages table.
   */
  deletePage(pagePath: string): void {
    this.db.prepare("DELETE FROM pages WHERE path = ?").run(pagePath);
  }

  /**
   * Get all pages for the tree, ordered by path.
   */
  getTree(): Array<{ path: string; name: string; type: PageType | "directory" }> {
    return this.db
      .prepare("SELECT path, name, file_type AS type FROM pages ORDER BY path")
      .all() as Array<{ path: string; name: string; type: PageType | "directory" }>;
  }

  close(): void {
    this.db.close();
  }
}
