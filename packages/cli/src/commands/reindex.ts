import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_PROJECT_ID } from "@ironlore/core";
import Database from "better-sqlite3";

interface ReindexOptions {
  all?: boolean;
  project: string;
}

/**
 * Extract wiki-link targets from markdown content.
 */
function extractWikiLinks(markdown: string): string[] {
  const links = new Set<string>();
  for (const match of markdown.matchAll(/(?:!|@)?\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]/g)) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return [...links];
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

  // Create tables if they don't exist
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(path, title, content)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS backlinks (
      source_path TEXT NOT NULL, target_path TEXT NOT NULL, link_text TEXT NOT NULL,
      PRIMARY KEY (source_path, target_path, link_text)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      path TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (path, tag)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_edits (
      path TEXT NOT NULL PRIMARY KEY,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      author TEXT NOT NULL DEFAULT 'reindex'
    )
  `);

  // Nuke existing data
  const clear = db.transaction(() => {
    db.prepare("DELETE FROM pages_fts").run();
    db.prepare("DELETE FROM backlinks").run();
    db.prepare("DELETE FROM tags").run();
    db.prepare("DELETE FROM recent_edits").run();
  });
  clear();

  // Walk data directory and index all .md files
  let indexed = 0;
  const insertFts = db.prepare("INSERT INTO pages_fts (path, title, content) VALUES (?, ?, ?)");
  const insertLink = db.prepare(
    "INSERT OR IGNORE INTO backlinks (source_path, target_path, link_text) VALUES (?, ?, ?)",
  );
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)");
  const insertEdit = db.prepare(
    "INSERT INTO recent_edits (path, updated_at, author) VALUES (?, datetime('now'), 'reindex')",
  );

  const indexPage = db.transaction((relPath: string, content: string) => {
    const title = extractTitle(content, relPath);
    insertFts.run(relPath, title, content);

    for (const target of extractWikiLinks(content)) {
      insertLink.run(relPath, target, target);
    }

    for (const tag of extractTags(content)) {
      insertTag.run(relPath, tag);
    }

    insertEdit.run(relPath);
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
      if (item.name.startsWith(".")) continue;
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.name.endsWith(".md")) {
        try {
          const content = readFileSync(fullPath, "utf-8");
          const relPath = relative(dataRoot, fullPath);
          indexPage(relPath, content);
          indexed++;
        } catch {
          console.warn(`  Skipping unreadable file: ${fullPath}`);
        }
      }
    }
  }

  walk(dataRoot);
  db.close();

  console.log(`  Indexed ${indexed} pages.`);
}
