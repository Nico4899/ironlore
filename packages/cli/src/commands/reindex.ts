import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  DEFAULT_PROJECT_ID,
  detectPageType,
  isSupportedExtension,
  parseBlocks,
} from "@ironlore/core";
import Database from "better-sqlite3";

interface ReindexOptions {
  all?: boolean;
  project: string;
}

/**
 * Extract wiki-link targets with optional typed relations.
 * Matches `[[Page]]`, `[[Page#blk_...]]`, `![[embed]]`, `@[[mention]]`,
 * and the pipe form `[[target | rel]]`. Mirrors the server's
 * search-index.ts regex so CLI rebuilds produce the same rows.
 */
function extractWikiLinks(markdown: string): Array<{ target: string; rel: string | null }> {
  const seen = new Map<string, { target: string; rel: string | null }>();
  const re = /(?:!|@)?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\s*\|\s*([a-z][a-z0-9_]*))?\]\]/g;
  for (const match of markdown.matchAll(re)) {
    const target = match[1]?.trim();
    if (!target) continue;
    const rel = match[2]?.trim() ?? null;
    const existing = seen.get(target);
    if (!existing || (rel && !existing.rel)) {
      seen.set(target, { target, rel });
    }
  }
  return [...seen.values()];
}

/**
 * Extract title from the first H1 heading, falling back to path.
 */
function extractTitle(markdown: string, pagePath: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() ?? pagePath;
}

/**
 * Extract tags from YAML frontmatter.
 */
function extractTags(markdown: string): string[] {
  if (!markdown.startsWith("---")) return [];
  const endIdx = markdown.indexOf("\n---", 3);
  if (endIdx === -1) return [];
  const frontmatter = markdown.slice(4, endIdx);

  const inlineMatch = /^tags:\s*\[([^\]]*)\]/m.exec(frontmatter);
  if (inlineMatch?.[1]) {
    return inlineMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

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
 * Rebuild .ironlore/index.sqlite from the data/ directory.
 * Nukes all existing index data and regenerates from markdown files.
 */
export function reindex(options: ReindexOptions): void {
  const installRoot = process.cwd();

  const projectIds = options.all ? listProjectIds(installRoot) : [options.project];

  for (const projectId of projectIds) {
    reindexProject(installRoot, projectId);
  }
}

function listProjectIds(installRoot: string): string[] {
  const projectsDir = join(installRoot, "projects");
  try {
    const entries = readdirSync(projectsDir, {
      withFileTypes: true,
      encoding: "utf-8",
    }) as import("node:fs").Dirent[];
    return entries.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    console.error("No projects/ directory found.");
    return [DEFAULT_PROJECT_ID];
  }
}

function reindexProject(installRoot: string, projectId: string): void {
  const projectDir = join(installRoot, "projects", projectId);
  const dataRoot = join(projectDir, "data");
  const dbPath = join(projectDir, ".ironlore", "index.sqlite");

  console.log(`Reindexing project "${projectId}"...`);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // ─── Schema ────────────────────────────────────────────────────
  // MUST stay in lockstep with `apps/web/src/server/search-index.ts`.
  // The pre-fix version of this file created only pages_fts +
  // backlinks + tags + recent_edits — missing the `pages` table
  // (the sidebar tree's source of truth), `pages_chunks_fts` (the
  // chunk-level index used for block-ID citations), and the `rel`
  // column on backlinks (typed wiki-link relations). Running
  // `ironlore lint --fix --check index-consistency` against a
  // corrupted index would quietly leave it MORE broken than before
  // because the sidebar then renders empty.
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(path, title, content)");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_chunks_fts USING fts5(
      path, chunk_idx, block_id_start, block_id_end, content
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS backlinks (
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      link_text TEXT NOT NULL,
      rel TEXT,
      PRIMARY KEY (source_path, target_path, link_text)
    )
  `);
  // Additive migration for databases created before typed relations.
  try {
    db.exec("ALTER TABLE backlinks ADD COLUMN rel TEXT");
  } catch {
    /* already exists */
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_path)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      path TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (path, tag)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_edits (
      path TEXT NOT NULL PRIMARY KEY,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      author TEXT NOT NULL DEFAULT 'reindex'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      path TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      parent TEXT,
      file_type TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent)");

  // Nuke existing data (both FTS tables + all derived rows).
  const clear = db.transaction(() => {
    db.prepare("DELETE FROM pages_fts").run();
    db.prepare("DELETE FROM pages_chunks_fts").run();
    db.prepare("DELETE FROM backlinks").run();
    db.prepare("DELETE FROM tags").run();
    db.prepare("DELETE FROM recent_edits").run();
    db.prepare("DELETE FROM pages").run();
  });
  clear();

  // ─── Inserts ───────────────────────────────────────────────────
  let indexed = 0;
  const insertFts = db.prepare("INSERT INTO pages_fts (path, title, content) VALUES (?, ?, ?)");
  const insertChunk = db.prepare(
    `INSERT INTO pages_chunks_fts (path, chunk_idx, block_id_start, block_id_end, content)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertLink = db.prepare(
    "INSERT OR IGNORE INTO backlinks (source_path, target_path, link_text, rel) VALUES (?, ?, ?, ?)",
  );
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)");
  const insertEdit = db.prepare(
    "INSERT INTO recent_edits (path, updated_at, author) VALUES (?, datetime('now'), 'reindex')",
  );
  const upsertPage = db.prepare(
    `INSERT INTO pages (path, name, parent, file_type, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       name = excluded.name,
       parent = excluded.parent,
       file_type = excluded.file_type,
       updated_at = datetime('now')`,
  );

  // Mirror SearchIndex's ancestor-directory materialization so the
  // sidebar shows folder rows. Top-level paths have parent=null;
  // nested paths ensure each dirname segment exists as a row.
  const ensureDirChain = (dirPath: string): void => {
    if (!dirPath || dirPath === ".") return;
    const parts = dirPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const parentDir = dirname(current);
      const parent = parentDir === "." ? null : parentDir;
      upsertPage.run(current, part, parent, "directory");
    }
  };

  const registerPage = (relPath: string): void => {
    const name = basename(relPath);
    const parentDir = dirname(relPath);
    const parent = parentDir === "." ? null : parentDir;
    if (parent) ensureDirChain(parent);
    const fileType = detectPageType(relPath);
    upsertPage.run(relPath, name, parent, fileType);
  };

  const indexMarkdown = db.transaction((relPath: string, content: string) => {
    const title = extractTitle(content, relPath);
    insertFts.run(relPath, title, content);

    // Chunk-level FTS: split at block-ID seams, ~800 tokens per chunk.
    const blocks = parseBlocks(content);
    if (blocks.length > 0) {
      let chunkIdx = 0;
      let chunkText = "";
      let chunkStartId = blocks[0]?.id ?? "";
      let chunkEndId = chunkStartId;

      for (const block of blocks) {
        const blockTokens = block.text.length / 4;
        if (chunkText.length > 0 && chunkText.length / 4 + blockTokens > 800) {
          insertChunk.run(relPath, chunkIdx, chunkStartId, chunkEndId, chunkText);
          chunkIdx++;
          chunkText = "";
          chunkStartId = block.id;
        }
        chunkText += (chunkText ? "\n\n" : "") + block.text;
        chunkEndId = block.id;
      }
      if (chunkText) insertChunk.run(relPath, chunkIdx, chunkStartId, chunkEndId, chunkText);
    }

    for (const link of extractWikiLinks(content)) {
      insertLink.run(relPath, link.target, link.target, link.rel);
    }
    for (const tag of extractTags(content)) {
      insertTag.run(relPath, tag);
    }
    insertEdit.run(relPath);
    registerPage(relPath);
  });

  function walk(dir: string): void {
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
      // Skip hidden dirs except .agents (agent personas + memory).
      if (item.name.startsWith(".") && item.name !== ".agents") continue;
      // Skip block-ID sidecars.
      if (item.name.endsWith(".blocks.json")) continue;

      const fullPath = join(dir, item.name);
      const relPath = relative(dataRoot, fullPath);

      if (item.isDirectory()) {
        // Register the directory row so the sidebar knows it exists
        // even if it's empty or only contains binaries.
        registerPage(relPath);
        walk(fullPath);
        continue;
      }

      // Non-markdown supported files still need a pages-table row
      // so the sidebar renders them. Only markdown flows into FTS.
      if (item.name.endsWith(".md")) {
        try {
          const content = readFileSync(fullPath, "utf-8");
          indexMarkdown(relPath, content);
          indexed++;
        } catch {
          console.warn(`  Skipping unreadable file: ${fullPath}`);
        }
      } else if (isSupportedExtension(item.name)) {
        registerPage(relPath);
      }
    }
  }

  walk(dataRoot);
  db.close();

  console.log(`  Indexed ${indexed} pages.`);
}
