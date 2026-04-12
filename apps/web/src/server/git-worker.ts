import { type SimpleGit, simpleGit } from "simple-git";
import type { Wal, WalEntry } from "./wal.js";

/** Default time window for grouping commits by author (ms). */
const DEFAULT_COMMIT_WINDOW_MS = 30_000;

interface CommitGroup {
  author: string;
  entries: WalEntry[];
  paths: Set<string>;
}

/**
 * Background git worker that drains committed WAL entries and produces
 * grouped git commits.
 *
 * Entries are grouped by author and time window (default 30s). Each group
 * becomes one commit. This means:
 * - Multi-user deployments naturally get one commit per author per burst
 * - Commit messages are correct (built from grouped ops)
 * - `git commit` failures don't block user writes
 */
export class GitWorker {
  private git: SimpleGit;
  private wal: Wal;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private commitWindowMs: number;

  constructor(projectDir: string, wal: Wal) {
    this.git = simpleGit(projectDir);
    this.wal = wal;
    this.commitWindowMs = Number(
      process.env.IRONLORE_GIT_COMMIT_WINDOW ?? DEFAULT_COMMIT_WINDOW_MS,
    );
  }

  /**
   * Initialize git repo if needed and start the periodic drain.
   */
  async start(): Promise<void> {
    // Ensure git repo exists
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
      console.log("Initialized git repository for project");
    }

    // Start periodic drain
    this.timer = setInterval(() => {
      this.drain().catch((err) => {
        console.error("Git worker drain error:", err);
      });
    }, this.commitWindowMs);
  }

  /**
   * Drain all committed WAL entries and produce git commits.
   * Can be called manually for "commit now" / `ironlore flush`.
   */
  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const entries = this.wal.getCommittedPending();
      if (entries.length === 0) return 0;

      // Group entries by author and time window
      const groups = this.groupEntries(entries);
      let committed = 0;

      for (const group of groups) {
        try {
          await this.commitGroup(group);
          committed += group.entries.length;
        } catch (err) {
          console.error(`Git commit failed for author "${group.author}":`, err);
        }
      }

      return committed;
    } finally {
      this.running = false;
    }
  }

  private groupEntries(entries: WalEntry[]): CommitGroup[] {
    const groups: CommitGroup[] = [];
    let current: CommitGroup | null = null;

    for (const entry of entries) {
      const entryTime = new Date(entry.createdAt).getTime();

      if (
        current &&
        current.author === entry.author &&
        entryTime - new Date(current.entries.at(-1)?.createdAt ?? entry.createdAt).getTime() <
          this.commitWindowMs
      ) {
        current.entries.push(entry);
        current.paths.add(entry.path);
      } else {
        current = {
          author: entry.author,
          entries: [entry],
          paths: new Set([entry.path]),
        };
        groups.push(current);
      }
    }

    return groups;
  }

  private async commitGroup(group: CommitGroup): Promise<void> {
    // Stage all affected paths
    for (const path of group.paths) {
      try {
        await this.git.add(`data/${path}`);
      } catch {
        // File might have been deleted
        try {
          await this.git.rm(`data/${path}`);
        } catch {
          // Ignore — file might not be tracked
        }
      }
    }

    // Check if there's anything staged
    const status = await this.git.status();
    if (status.staged.length === 0) {
      // Nothing to commit — clean up WAL entries anyway
      this.wal.deleteConsumed(group.entries.map((e) => e.id));
      return;
    }

    // Build commit message from grouped operations
    const message = this.buildCommitMessage(group);

    await this.git.commit(message, undefined, {
      "--author": `${group.author} <${group.author}@ironlore.local>`,
    });

    // Clean up consumed WAL entries
    this.wal.deleteConsumed(group.entries.map((e) => e.id));
  }

  private buildCommitMessage(group: CommitGroup): string {
    const paths = [...group.paths];

    if (paths.length === 1) {
      const entry = group.entries[0];
      if (!entry) return `Update ${paths[0]}`;
      return entry.message || `${entry.op === "delete" ? "Delete" : "Update"} ${paths[0]}`;
    }

    const summary =
      paths.length <= 5 ? `Update ${paths.join(", ")}` : `Update ${paths.length} files`;

    const details = group.entries.map((e) => `- ${e.message || `${e.op} ${e.path}`}`).join("\n");

    return `${summary}\n\n${details}`;
  }

  /**
   * Stop the periodic drain timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
