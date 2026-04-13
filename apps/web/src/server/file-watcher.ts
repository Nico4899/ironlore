import { existsSync, watch as fsWatch, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { isBinaryExtension, isSupportedExtension } from "@ironlore/core";
import { computeEtag } from "@ironlore/core/server";
import { type FSWatcher as ChokidarWatcher, watch as chokidarWatch } from "chokidar";
import type { SearchIndex } from "./search-index.js";
import type { Wal } from "./wal.js";

/**
 * Filesystem watcher that detects external edits (e.g. user editing
 * markdown files in VS Code or vim) and feeds them into the WAL.
 *
 * Uses chokidar in development and Node's built-in fs.watch in production
 * for a lighter runtime footprint.
 *
 * Debounced at 200ms to avoid churn from editor save-write patterns.
 */
export class FileWatcher {
  private chokidarWatcher: ChokidarWatcher | null = null;
  private fsWatcher: ReturnType<typeof fsWatch> | null = null;
  private wal: Wal;
  private dataRoot: string;
  private searchIndex: SearchIndex | null;
  private knownHashes = new Map<string, string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dataRoot: string, wal: Wal, searchIndex?: SearchIndex) {
    this.dataRoot = dataRoot;
    this.wal = wal;
    this.searchIndex = searchIndex ?? null;
  }

  /**
   * Start watching the data directory for changes.
   */
  start(): void {
    if (process.env.NODE_ENV === "production") {
      this.startFsWatch();
    } else {
      this.startChokidar();
    }
  }

  /**
   * Production backend: Node's built-in fs.watch with recursive mode.
   * Available on macOS, Windows, and Linux (Node 19.1+).
   */
  private startFsWatch(): void {
    this.fsWatcher = fsWatch(this.dataRoot, { recursive: true }, (eventType, filename) => {
      if (!filename || typeof filename !== "string") return;

      // Skip unsupported, hidden files, sidecars, and temp files
      if (!isSupportedExtension(filename)) return;
      if (/(^|[/\\])\./.test(filename)) return;

      const absPath = join(this.dataRoot, filename);

      if (eventType === "rename") {
        // 'rename' covers both creation and deletion — check existence
        if (existsSync(absPath)) {
          this.handleChange(absPath);
        } else {
          this.handleDelete(absPath);
        }
      } else {
        // 'change' — file content was modified
        this.handleChange(absPath);
      }
    });
  }

  /**
   * Development backend: chokidar with richer event handling and
   * awaitWriteFinish for editor save patterns.
   */
  private startChokidar(): void {
    this.chokidarWatcher = chokidarWatch(this.dataRoot, {
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

    this.chokidarWatcher.on("change", (filePath: string) => {
      this.handleChange(filePath);
    });

    this.chokidarWatcher.on("add", (filePath: string) => {
      this.handleChange(filePath);
    });

    this.chokidarWatcher.on("unlink", (filePath: string) => {
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
    if (!isSupportedExtension(basename(filePath))) return;

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
      // Read as buffer for binary-safe hashing
      const buffer = readFileSync(filePath);
      const newHash = computeEtag(buffer);
      const knownHash = this.knownHashes.get(filePath);

      // If hash matches our last known write, this is our own write — skip
      if (knownHash === newHash) return;

      const relPath = relative(this.dataRoot, filePath);
      const binary = isBinaryExtension(basename(filePath));
      // Binary files (PDF, images, video, audio) cannot be safely decoded
      // as UTF-8 — store null content. The file already exists on disk;
      // the WAL entry is only for git tracking.
      const content = binary ? null : buffer.toString("utf-8");

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
      const uncommitted = this.wal.getUncommitted().filter((e) => e.path === relPath);
      for (const entry of uncommitted) {
        this.wal.markCommitted(entry.id);
      }

      // Update search index (text files only)
      if (!binary) {
        this.searchIndex?.indexPage(relPath, content ?? "", "external");
      }

      // Update known hash
      this.knownHashes.set(filePath, newHash);
    } catch {
      // File might be mid-write or deleted — ignore
    }
  }

  private handleDelete(filePath: string): void {
    if (!isSupportedExtension(basename(filePath))) return;

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

    // Remove from search index
    this.searchIndex?.removePage(relPath);

    this.knownHashes.delete(filePath);
  }

  stop(): void {
    if (this.chokidarWatcher) {
      this.chokidarWatcher.close();
      this.chokidarWatcher = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
