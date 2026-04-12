import { join } from "node:path";
import Database from "better-sqlite3";
import { simpleGit } from "simple-git";

interface FlushOptions {
  project: string;
}

interface WalRow {
  id: number;
  path: string;
  op: string;
  author: string;
  message: string;
}

/**
 * Drain all committed WAL entries into git immediately.
 *
 * Bypasses the 30-second grouping window — useful before a demo,
 * a backup, or a `git push`.
 */
export async function flush(options: FlushOptions): Promise<void> {
  const installRoot = process.cwd();
  const projectDir = join(installRoot, "projects", options.project);
  const walPath = join(projectDir, ".ironlore", "wal", "wal.sqlite");

  let db: Database.Database;
  try {
    db = new Database(walPath);
  } catch {
    console.error(`No WAL database found for project "${options.project}".`);
    console.error(`Expected at: ${walPath}`);
    process.exit(1);
  }

  try {
    // Get all committed-but-not-consumed entries
    const entries = db
      .prepare(
        `SELECT id, path, op, author, message FROM wal_entries WHERE committed = 1 ORDER BY id`,
      )
      .all() as WalRow[];

    if (entries.length === 0) {
      console.log("Nothing to flush — WAL is clean.");
      return;
    }

    console.log(`Flushing ${entries.length} WAL entries to git...`);

    const git = simpleGit(projectDir);

    // Ensure git repo exists
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      await git.init();
      console.log("Initialized git repository.");
    }

    // Group entries by author
    const groups = new Map<string, WalRow[]>();
    for (const entry of entries) {
      const existing = groups.get(entry.author) ?? [];
      existing.push(entry);
      groups.set(entry.author, existing);
    }

    let committed = 0;

    for (const [author, authorEntries] of groups) {
      // Stage all affected paths
      const paths = new Set(authorEntries.map((e) => e.path));
      for (const path of paths) {
        try {
          await git.add(`data/${path}`);
        } catch {
          try {
            await git.rm(`data/${path}`);
          } catch {
            // File might not be tracked
          }
        }
      }

      // Check if there's anything staged
      const status = await git.status();
      if (status.staged.length === 0) {
        // Nothing to commit — clean up WAL entries
        const ids = authorEntries.map((e) => e.id);
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(`DELETE FROM wal_entries WHERE id IN (${placeholders})`).run(...ids);
        committed += authorEntries.length;
        continue;
      }

      // Build commit message
      const messages = authorEntries
        .map((e) => e.message || `${e.op} ${e.path}`)
        .filter((m, i, a) => a.indexOf(m) === i);
      const summary = messages.length === 1 ? messages[0] : `Update ${paths.size} files`;
      const details = messages.length > 1 ? `\n\n${messages.map((m) => `- ${m}`).join("\n")}` : "";
      const message = `${summary}${details}`;

      await git.commit(message, undefined, {
        "--author": `${author} <${author}@ironlore.local>`,
      });

      // Clean up consumed WAL entries
      const ids = authorEntries.map((e) => e.id);
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM wal_entries WHERE id IN (${placeholders})`).run(...ids);
      committed += authorEntries.length;

      console.log(`  Committed ${authorEntries.length} entries by "${author}"`);
    }

    console.log(`Flushed ${committed} entries to git.`);
  } finally {
    db.close();
  }
}
