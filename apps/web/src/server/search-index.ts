import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import Database from "better-sqlite3";

/**
 * Wiki-link patterns in markdown:
 *   [[Page Name]]          — wikilink
 *   [[Page Name#blk_...]]  — block reference
 *   ![[Page Name]]         — embed
 *   @[[Page Name]]         — mention
 */
const WIKILINK_RE = /(?:!|@)?\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]/g;

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

/**
 * Extract wiki-link targets from markdown content.
 * Returns deduplicated target page names (without anchors or prefixes).
 */
export function extractWikiLinks(markdown: string): string[] {
  const links = new Set<string>();
  for (const match of markdown.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return [...links];
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
        PRIMARY KEY (source_path, target_path, link_text)
      )
    `);

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
  }

  /**
   * Index a page after a write. Replaces any existing entry for this path.
   */
  indexPage(pagePath: string, content: string, author: string): void {
    const title = extractTitle(content, pagePath);
    const tags = extractTags(content);
    const links = extractWikiLinks(content);

    const txn = this.db.transaction(() => {
      // FTS5: delete old, insert new
      this.db.prepare("DELETE FROM pages_fts WHERE path = ?").run(pagePath);
      this.db
        .prepare("INSERT INTO pages_fts (path, title, content) VALUES (?, ?, ?)")
        .run(pagePath, title, content);

      // Backlinks: delete old outgoing links, insert new
      this.db.prepare("DELETE FROM backlinks WHERE source_path = ?").run(pagePath);
      const insertLink = this.db.prepare(
        "INSERT OR IGNORE INTO backlinks (source_path, target_path, link_text) VALUES (?, ?, ?)",
      );
      for (const target of links) {
        insertLink.run(pagePath, target, target);
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
  }

  /**
   * Full-text search via FTS5. Returns results ranked by relevance.
   */
  search(query: string, limit = 20): SearchResult[] {
    return this.db
      .prepare(
        `SELECT path, title, snippet(pages_fts, 2, '<mark>', '</mark>', '…', 32) AS snippet,
                rank
         FROM pages_fts
         WHERE pages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as SearchResult[];
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
   */
  reindexAll(dataRoot: string): { indexed: number } {
    // Clear all tables
    const clear = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pages_fts").run();
      this.db.prepare("DELETE FROM backlinks").run();
      this.db.prepare("DELETE FROM tags").run();
      this.db.prepare("DELETE FROM recent_edits").run();
    });
    clear();

    // Walk data directory and index all .md files
    let indexed = 0;
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
        if (item.name.startsWith(".")) continue;
        const fullPath = join(dir, item.name);
        if (item.isDirectory()) {
          walk(fullPath);
        } else if (item.name.endsWith(".md")) {
          try {
            const content = readFileSync(fullPath, "utf-8");
            const relPath = relative(dataRoot, fullPath);
            this.indexPage(relPath, content, "reindex");
            indexed++;
          } catch {
            // Skip unreadable files
          }
        }
      }
    };

    walk(dataRoot);
    return { indexed };
  }

  close(): void {
    this.db.close();
  }
}
