import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { computeEtag } from "@ironlore/core";
import { type FSWatcher, watch } from "chokidar";
import type { Wal } from "./wal.js";

/**
 * Filesystem watcher that detects external edits (e.g. user editing
 * markdown files in VS Code or vim) and feeds them into the WAL.
 *
 * Debounced at 200ms to avoid churn from editor save-write patterns.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private wal: Wal;
  private dataRoot: string;
  private knownHashes = new Map<string, string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dataRoot: string, wal: Wal) {
    this.dataRoot = dataRoot;
    this.wal = wal;
  }

  /**
   * Start watching the data directory for changes.
   */
  start(): void {
    this.watcher = watch(this.dataRoot, {
      ignored: [
        /(^|[/\\])\../, // hidden files
        /\.blocks\.json$/, // sidecar files
        /\.tmp$/, // temp files from atomic writes
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    this.watcher.on("change", (filePath: string) => {
      this.handleChange(filePath);
    });

    this.watcher.on("add", (filePath: string) => {
      this.handleChange(filePath);
    });

    this.watcher.on("unlink", (filePath: string) => {
      this.handleDelete(filePath);
    });
  }

  /**
   * Record the current hash of a file so we can detect external changes.
   * Called after StorageWriter completes a write.
   */
  recordHash(absPath: string, hash: string): void {
    this.knownHashes.set(absPath, hash);
  }

  private handleChange(filePath: string): void {
    // Only watch markdown files
    if (!filePath.endsWith(".md")) return;

    // Debounce
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.processChange(filePath);
      }, 200),
    );
  }

  private processChange(filePath: string): void {
    try {
      const content = readFileSync(filePath, "utf-8");
      const newHash = computeEtag(content);
      const knownHash = this.knownHashes.get(filePath);

      // If hash matches our last known write, this is our own write — skip
      if (knownHash === newHash) return;

      const relPath = relative(this.dataRoot, filePath);

      // External edit detected — record in WAL
      this.wal.append({
        path: relPath,
        op: "write",
        preHash: knownHash ?? null,
        postHash: newHash,
        content,
        author: "external",
        message: `External edit: ${relPath}`,
      });

      // The filesystem write already happened, so mark committed immediately
      // (the WAL entry is just for git tracking)
      const _entries = this.wal.getCommittedPending(1);
      // Mark the latest uncommitted entry for this path
      const uncommitted = this.wal.getUncommitted().filter((e) => e.path === relPath);
      for (const entry of uncommitted) {
        this.wal.markCommitted(entry.id);
      }

      // Update known hash
      this.knownHashes.set(filePath, newHash);
    } catch {
      // File might be mid-write or deleted — ignore
    }
  }

  private handleDelete(filePath: string): void {
    if (!filePath.endsWith(".md")) return;

    const relPath = relative(this.dataRoot, filePath);
    const knownHash = this.knownHashes.get(filePath);

    this.wal.append({
      path: relPath,
      op: "delete",
      preHash: knownHash ?? null,
      postHash: null,
      content: null,
      author: "external",
      message: `External delete: ${relPath}`,
    });

    this.knownHashes.delete(filePath);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
