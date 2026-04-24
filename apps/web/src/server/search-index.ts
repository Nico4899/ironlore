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

/**
 * Extract the `kind:` frontmatter value — one of "page", "source",
 * "wiki", matching `packages/core/src/schemas.ts`. Returns null when
 * the key is absent or the value is not a recognized member; callers
 * treat null as "no kind declared" rather than flagging a parse error,
 * because unlabelled pages are legitimate.
 */
function extractKind(markdown: string): "page" | "source" | "wiki" | null {
  if (!markdown.startsWith("---")) return null;
  const endIdx = markdown.indexOf("\n---", 3);
  if (endIdx === -1) return null;
  const frontmatter = markdown.slice(4, endIdx);
  const match = /^kind\s*:\s*"?(page|source|wiki)"?\s*$/m.exec(frontmatter);
  return (match?.[1] as "page" | "source" | "wiki" | undefined) ?? null;
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
  /** Typed-relation label from `[[target | rel]]` syntax, or null for plain links. */
  rel: string | null;
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

    // Phase-11: `kind` column mirrors the frontmatter `kind:` field
    // ("page" | "source" | "wiki") for pages that declare one. Null
    // otherwise — directory rows and pages without frontmatter stay
    // null. Additive migration so existing installs pick it up
    // silently; `ironlore reindex` repopulates it.
    const pagesCols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{
      name: string;
    }>;
    if (!pagesCols.some((c) => c.name === "kind")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN kind TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_pages_kind ON pages(kind)");

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

    // Phase-11: chunk-level embeddings for hybrid retrieval. Keyed by
    // (path, chunk_idx) to align with pages_chunks_fts. `dims` stored
    // per-row so a mid-stream provider swap (e.g. text-embedding-3-small
    // → 3-large) fails loudly rather than silently comparing vectors
    // in different spaces. `model` is informational — surfaces on the
    // "reindex needed" chip when the configured model doesn't match.
    //
    // Embeddings are stored as raw Float32 BLOBs (little-endian native)
    // rather than through sqlite-vec. Cosine is computed in JS against
    // the BM25-prefilter's ~250-chunk working set — the native extension
    // becomes worthwhile only at vault scales where full-vault ANN
    // matters, which the prefilter explicitly avoids. See
    // docs/06-implementation-roadmap.md §Phase 11 → Hybrid retrieval.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_vectors (
        path       TEXT NOT NULL,
        chunk_idx  INTEGER NOT NULL,
        dims       INTEGER NOT NULL,
        model      TEXT NOT NULL,
        embedding  BLOB NOT NULL,
        PRIMARY KEY (path, chunk_idx)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunk_vectors_path ON chunk_vectors(path)");
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
      // Phase-11: chunk boundaries may have shifted with the rewrite,
      // so old embeddings no longer align with the new chunk_idx
      // numbering. Drop them — the backfill pass re-embeds.
      this.db.prepare("DELETE FROM chunk_vectors WHERE path = ?").run(pagePath);
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

    // Update pages table (outside FTS transaction for simplicity).
    // `kind` is mirrored from frontmatter for use by the stale-source
    // detector (docs/04-ai-and-agents.md §Wiki-gardener) — null when
    // the file has no frontmatter or no `kind:` key.
    const fileType = detectPageType(pagePath);
    this.upsertPage(pagePath, fileType, extractKind(content));
  }

  /**
   * Remove a page from the index (after deletion).
   */
  removePage(pagePath: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pages_fts WHERE path = ?").run(pagePath);
      this.db.prepare("DELETE FROM pages_chunks_fts WHERE path = ?").run(pagePath);
      this.db.prepare("DELETE FROM backlinks WHERE source_path = ?").run(pagePath);
      this.db.prepare("DELETE FROM tags WHERE path = ?").run(pagePath);
      this.db.prepare("DELETE FROM recent_edits WHERE path = ?").run(pagePath);
      // Cascade hybrid-retrieval embeddings alongside the FTS rows —
      // a deleted page must not linger as ghost vectors.
      this.db.prepare("DELETE FROM chunk_vectors WHERE path = ?").run(pagePath);
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
        if (r.blockIdStart)
          (existing.result as unknown as Record<string, unknown>).blockIdStart = r.blockIdStart;
        if (r.blockIdEnd)
          (existing.result as unknown as Record<string, unknown>).blockIdEnd = r.blockIdEnd;
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
   *
   * Optionally filters by typed relation (`[[target | rel]]` syntax).
   * When `rel` is provided, only backlinks with that exact relation
   * label are returned. When omitted, all backlinks (typed + untyped)
   * are returned so existing callers behave unchanged.
   *
   * See docs/01-content-model.md §Wiki-link relations.
   */
  getBacklinks(targetPath: string, rel?: string): BacklinkEntry[] {
    if (rel !== undefined) {
      return this.db
        .prepare(
          "SELECT source_path AS sourcePath, link_text AS linkText, rel FROM backlinks WHERE target_path = ? AND rel = ?",
        )
        .all(targetPath, rel) as BacklinkEntry[];
    }
    return this.db
      .prepare(
        "SELECT source_path AS sourcePath, link_text AS linkText, rel FROM backlinks WHERE target_path = ?",
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
   * Wiki pages whose cited sources were modified more recently — the
   * Phase-11 stale-source check from the Wiki Gardener's lint skill.
   *
   * A wiki page W is considered stale relative to source S when:
   *   (1) `W.kind = 'wiki'`
   *   (2) W has an outbound wiki-link that resolves to S
   *   (3) `S.kind = 'source'`
   *   (4) `S.updated_at > W.updated_at`
   *
   * Link resolution mirrors `findOrphans`: the `backlinks` table
   * stores raw `[[target]]` text, so we compare against the three
   * common spellings of each source's path (full, stripped `.md`,
   * basename stem).
   *
   * Timestamps in the `pages` table are ISO-8601 strings produced by
   * `datetime('now')`, so lexical comparison is chronological. Strict
   * greater-than avoids flagging the identical-mtime case produced by
   * a bulk reindex.
   *
   * One row per (wiki, source) pair. A wiki citing three stale
   * sources emits three rows so the report shows each pairing.
   */
  findStaleSources(): Array<{
    wikiPath: string;
    wikiUpdatedAt: string;
    sourcePath: string;
    sourceUpdatedAt: string;
  }> {
    const wikis = this.db
      .prepare(
        "SELECT path, updated_at AS updatedAt FROM pages WHERE kind = 'wiki' AND file_type = 'markdown'",
      )
      .all() as Array<{ path: string; updatedAt: string }>;
    if (wikis.length === 0) return [];

    const sources = this.db
      .prepare(
        "SELECT path, updated_at AS updatedAt FROM pages WHERE kind = 'source' AND file_type = 'markdown'",
      )
      .all() as Array<{ path: string; updatedAt: string }>;
    if (sources.length === 0) return [];

    // Index sources by every linkable spelling so wiki outbound links
    // resolve with the same semantics the user uses when authoring.
    const sourceByKey = new Map<string, { path: string; updatedAt: string }>();
    for (const s of sources) {
      for (const key of linkTargetCandidates(s.path)) sourceByKey.set(key, s);
    }

    const getOutlinks = this.db.prepare(
      "SELECT DISTINCT target_path AS target FROM backlinks WHERE source_path = ?",
    );

    const out: Array<{
      wikiPath: string;
      wikiUpdatedAt: string;
      sourcePath: string;
      sourceUpdatedAt: string;
    }> = [];
    for (const wiki of wikis) {
      const links = getOutlinks.all(wiki.path) as Array<{ target: string }>;
      const seen = new Set<string>();
      for (const { target } of links) {
        const source = sourceByKey.get(target);
        if (!source) continue;
        if (seen.has(source.path)) continue;
        seen.add(source.path);
        if (source.updatedAt > wiki.updatedAt) {
          out.push({
            wikiPath: wiki.path,
            wikiUpdatedAt: wiki.updatedAt,
            sourcePath: source.path,
            sourceUpdatedAt: source.updatedAt,
          });
        }
      }
    }
    // Stable ordering: wiki path then source path so repeat runs
    // produce identical diffs when nothing has moved.
    out.sort(
      (a, b) => a.wikiPath.localeCompare(b.wikiPath) || a.sourcePath.localeCompare(b.sourcePath),
    );
    return out;
  }

  /**
   * Pages with zero inbound wiki-links, ordered by path. Consumed by
   * the Wiki Gardener's `kb.lint_orphans` tool (Phase 11). Callers pass
   * a list of path prefixes to skip — by default `_maintenance/`,
   * `getting-started/`, and `.agents/` are excluded so the report
   * doesn't flag self-documentation or agent-local pages.
   *
   * Markdown-only: binaries (pdf/csv/img) are not expected to carry
   * wiki-links and would always appear as "orphans," drowning real
   * signal.
   *
   * Link-target resolution: the `backlinks` table stores the raw
   * target text from `[[...]]` (e.g. `[[spoke]]` → `target_path =
   * "spoke"`), not a filesystem path. A page at `notes/spoke.md` is
   * considered linked if any backlink target equals the full path, the
   * path without `.md`, or just the basename stem — matching the three
   * common ways a user writes a wiki-link.
   */
  findOrphans(opts?: { excludePrefixes?: readonly string[] }): Array<{
    path: string;
    updatedAt: string;
  }> {
    const excludePrefixes = opts?.excludePrefixes ?? [
      "_maintenance/",
      "getting-started/",
      ".agents/",
    ];

    const pages = this.db
      .prepare("SELECT path, updated_at AS updatedAt FROM pages WHERE file_type = 'markdown'")
      .all() as Array<{ path: string; updatedAt: string }>;

    const targetRows = this.db
      .prepare("SELECT DISTINCT target_path AS target FROM backlinks")
      .all() as Array<{ target: string }>;
    const targets = new Set(targetRows.map((r) => r.target));

    const out: Array<{ path: string; updatedAt: string }> = [];
    for (const page of pages) {
      if (excludePrefixes.some((pre) => page.path.startsWith(pre))) continue;
      const candidates = linkTargetCandidates(page.path);
      const linked = candidates.some((c) => targets.has(c));
      if (!linked) out.push(page);
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  // -------------------------------------------------------------------------
  // Phase-11 hybrid retrieval — chunk_vectors read/write + cosine search.
  // The BM25-prefilter caps search to ~250 chunks, so an in-JS cosine loop
  // over prepared Float32Arrays is fast enough; no sqlite-vec dependency.
  // Docs: 04-ai-and-agents.md §Phase 11 additions,
  //       06-implementation-roadmap.md §Hybrid retrieval.
  // -------------------------------------------------------------------------

  /**
   * BM25 prefilter for the hybrid-retrieval path. Runs a chunk-level
   * FTS5 match against `query`, returning the first `limit` distinct
   * page paths along with their best rank (lowest = most relevant).
   * The caller then runs `vectorSearch` against this candidate list
   * so cosine sweeps stay O(1) in vault size.
   *
   * The rank map doubles as a BM25-side input for the final RRF merge
   * so the caller doesn't have to re-query.
   */
  bm25PrefilterPaths(query: string, limit = 50): Map<string, number> {
    const tokens = query
      .split(/\s+/)
      .map((t) => t.replace(/"/g, ""))
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return new Map();
    const ftsQuery = tokens.map((t) => `"${t}"*`).join(" ");

    const rows = this.db
      .prepare(
        `SELECT path, rank
         FROM pages_chunks_fts
         WHERE pages_chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit * 3) as Array<{ path: string; rank: number }>;

    // Keep each path at its best chunk-level rank — pages with many
    // chunk matches shouldn't surface multiple times in the prefilter.
    const pathRank = new Map<string, number>();
    let idx = 0;
    for (const row of rows) {
      if (pathRank.has(row.path)) continue;
      pathRank.set(row.path, idx++);
      if (pathRank.size >= limit) break;
    }
    return pathRank;
  }

  /**
   * Write an embedding for a single chunk. The `embedding` array is
   * converted to a little-endian Float32 BLOB; `dims` must match
   * `embedding.length` and is stored alongside so a mid-stream model
   * swap fails loudly on read. Upserts on conflict so re-embedding
   * after a provider change works without an explicit delete.
   */
  storeChunkEmbedding(
    pagePath: string,
    chunkIdx: number,
    embedding: readonly number[],
    model: string,
  ): void {
    const blob = Buffer.from(new Float32Array(embedding).buffer);
    this.db
      .prepare(
        `INSERT INTO chunk_vectors (path, chunk_idx, dims, model, embedding)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, chunk_idx) DO UPDATE SET
           dims = excluded.dims,
           model = excluded.model,
           embedding = excluded.embedding`,
      )
      .run(pagePath, chunkIdx, embedding.length, model, blob);
  }

  /** Enumerate chunks that have FTS content but no embedding yet. */
  getChunksMissingEmbeddings(
    limit = 100,
  ): Array<{ path: string; chunkIdx: number; content: string }> {
    return this.db
      .prepare(
        `SELECT c.path AS path, c.chunk_idx AS chunkIdx, c.content AS content
         FROM pages_chunks_fts c
         LEFT JOIN chunk_vectors v
           ON v.path = c.path AND v.chunk_idx = c.chunk_idx
         WHERE v.path IS NULL
         LIMIT ?`,
      )
      .all(limit) as Array<{ path: string; chunkIdx: number; content: string }>;
  }

  /** How many chunks are indexed but haven't been embedded yet. */
  countChunksMissingEmbeddings(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM pages_chunks_fts c
         LEFT JOIN chunk_vectors v
           ON v.path = c.path AND v.chunk_idx = c.chunk_idx
         WHERE v.path IS NULL`,
      )
      .get() as { n: number };
    return row.n;
  }

  /** Total number of chunks in the FTS table. Drives the status endpoint's progress bar. */
  countChunksTotal(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pages_chunks_fts").get() as {
      n: number;
    };
    return row.n;
  }

  /**
   * How many chunk_vectors rows were produced by a model other than
   * `currentModel`. Surfaces a "model drift" badge on the status
   * endpoint — embeddings from a retired provider stay queryable by
   * vectorSearch's dim check but produce mismatched cosine scores.
   */
  countChunksWithMismatchedModel(currentModel: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM chunk_vectors WHERE model != ?")
      .get(currentModel) as { n: number };
    return row.n;
  }

  /**
   * Look up page titles for a batch of paths in one query. Falls back
   * to the path itself when the page is unindexed.
   */
  getPageTitles(paths: readonly string[]): Map<string, string> {
    if (paths.length === 0) return new Map();
    const placeholders = paths.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT path, title FROM pages_fts WHERE path IN (${placeholders})`)
      .all(...paths) as Array<{ path: string; title: string }>;
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.path, row.title);
    return map;
  }

  /**
   * First (lowest chunk_idx) chunk for a page — used as a snippet
   * fallback when a semantic-search result surfaced via BM25 only
   * and we don't already have a block-ID pin.
   */
  getBestChunk(
    pagePath: string,
  ): { chunkIdx: number; blockIdStart: string | null; blockIdEnd: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT chunk_idx AS chunkIdx,
                block_id_start AS blockIdStart,
                block_id_end AS blockIdEnd
         FROM pages_chunks_fts WHERE path = ? ORDER BY chunk_idx LIMIT 1`,
      )
      .get(pagePath) as
      | { chunkIdx: number; blockIdStart: string | null; blockIdEnd: string | null }
      | undefined;
    return row ?? null;
  }

  /** Raw text of a specific chunk — used to build semantic-search snippets. */
  getChunkText(pagePath: string, chunkIdx: number): string {
    const row = this.db
      .prepare("SELECT content FROM pages_chunks_fts WHERE path = ? AND chunk_idx = ?")
      .get(pagePath, chunkIdx) as { content: string } | undefined;
    return row?.content ?? "";
  }

  /**
   * Vector-search a prepared query embedding against the chunks
   * belonging to `candidatePaths` (the BM25-prefilter output).
   * Returns the top-`topK` matches sorted by cosine similarity
   * descending.
   *
   * Enforces dimensionality: if any stored chunk's `dims` disagrees
   * with the query's length, it's skipped rather than compared across
   * spaces. A vault with partial embeddings (e.g. mid-backfill) returns
   * whatever's already there — callers can combine with BM25 results to
   * fill the gap.
   */
  vectorSearch(
    queryEmbedding: readonly number[],
    candidatePaths: readonly string[],
    topK: number,
  ): Array<{
    path: string;
    chunkIdx: number;
    blockIdStart: string | null;
    blockIdEnd: string | null;
    score: number;
  }> {
    if (candidatePaths.length === 0 || queryEmbedding.length === 0 || topK <= 0) {
      return [];
    }

    const placeholders = candidatePaths.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT v.path AS path,
                v.chunk_idx AS chunkIdx,
                v.dims AS dims,
                v.embedding AS embedding,
                c.block_id_start AS blockIdStart,
                c.block_id_end AS blockIdEnd
         FROM chunk_vectors v
         JOIN pages_chunks_fts c
           ON c.path = v.path AND c.chunk_idx = v.chunk_idx
         WHERE v.path IN (${placeholders})`,
      )
      .all(...candidatePaths) as Array<{
      path: string;
      chunkIdx: number;
      dims: number;
      embedding: Buffer;
      blockIdStart: string | null;
      blockIdEnd: string | null;
    }>;

    const queryNorm = vectorNorm(queryEmbedding);
    if (queryNorm === 0) return [];

    const scored: Array<{
      path: string;
      chunkIdx: number;
      blockIdStart: string | null;
      blockIdEnd: string | null;
      score: number;
    }> = [];
    for (const row of rows) {
      if (row.dims !== queryEmbedding.length) continue;
      const stored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const score = cosineSimilarity(queryEmbedding, stored, queryNorm);
      scored.push({
        path: row.path,
        chunkIdx: row.chunkIdx,
        blockIdStart: row.blockIdStart,
        blockIdEnd: row.blockIdEnd,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
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
      this.db.prepare("DELETE FROM pages_chunks_fts").run();
      this.db.prepare("DELETE FROM backlinks").run();
      this.db.prepare("DELETE FROM tags").run();
      this.db.prepare("DELETE FROM recent_edits").run();
      this.db.prepare("DELETE FROM pages").run();
      this.db.prepare("DELETE FROM chunk_vectors").run();
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
   * Insert or update a page entry in the pages table. `kind` mirrors
   * the frontmatter value when the caller parsed it (markdown pages);
   * pass null for directories or non-markdown files.
   * Also ensures all ancestor directories exist as entries.
   */
  upsertPage(
    pagePath: string,
    fileType: PageType | "directory",
    kind: "page" | "source" | "wiki" | null = null,
  ): void {
    const name = basename(pagePath);
    const parentDir = dirname(pagePath);
    const parent = parentDir === "." ? null : parentDir;

    // Ensure ancestor directories exist
    if (parent) {
      this.ensureDirectoryChain(parent);
    }

    this.db
      .prepare(
        `INSERT INTO pages (path, name, parent, file_type, kind, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           parent = excluded.parent,
           file_type = excluded.file_type,
           kind = excluded.kind,
           updated_at = datetime('now')`,
      )
      .run(pagePath, name, parent, fileType, kind);
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

/**
 * L2 norm (magnitude) of an embedding. Split out so the query side
 * computes it once per `vectorSearch` call instead of N times.
 */
function vectorNorm(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

/**
 * Cosine similarity between a query and a stored chunk embedding.
 * Caller supplies the precomputed `queryNorm` to avoid recomputing it
 * across a prefilter sweep. Assumes the stored vector is non-zero;
 * returns 0 for the degenerate case so the chunk simply ranks last.
 */
function cosineSimilarity(
  query: ArrayLike<number>,
  stored: ArrayLike<number>,
  queryNorm: number,
): number {
  let dot = 0;
  let storedSumSq = 0;
  const n = Math.min(query.length, stored.length);
  for (let i = 0; i < n; i++) {
    const a = query[i] ?? 0;
    const b = stored[i] ?? 0;
    dot += a * b;
    storedSumSq += b * b;
  }
  const storedNorm = Math.sqrt(storedSumSq);
  if (storedNorm === 0 || queryNorm === 0) return 0;
  return dot / (queryNorm * storedNorm);
}

/**
 * The three ways a user commonly writes a wiki-link to a page at
 * `notes/spoke.md`: the full path (`notes/spoke.md`), the path minus
 * `.md` (`notes/spoke`), and just the basename stem (`spoke`). Used by
 * `findOrphans` to decide whether a page has any inbound link under
 * any of those spellings.
 */
function linkTargetCandidates(pagePath: string): string[] {
  const noExt = pagePath.replace(/\.md$/, "");
  const slashIdx = noExt.lastIndexOf("/");
  const basename = slashIdx === -1 ? noExt : noExt.slice(slashIdx + 1);
  const candidates = new Set<string>([pagePath, noExt, basename]);
  return [...candidates];
}
