import { existsSync, watch as fsWatch, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { WsEventInput } from "@ironlore/core";
import {
  detectPageType,
  extractableFormat,
  isBinaryExtension,
  isSupportedExtension,
} from "@ironlore/core";
import { extract } from "@ironlore/core/extractors";
import { computeEtag } from "@ironlore/core/server";
import { type FSWatcher as ChokidarWatcher, watch as chokidarWatch } from "chokidar";
import type { SearchIndex } from "./search-index.js";
import type { Wal } from "./wal.js";

type BroadcastFn = (event: WsEventInput) => void;

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
  private broadcast: BroadcastFn | null;
  private knownPaths = new Set<string>();
  private knownHashes = new Map<string, string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dataRoot: string, wal: Wal, searchIndex?: SearchIndex, broadcast?: BroadcastFn) {
    this.dataRoot = dataRoot;
    this.wal = wal;
    this.searchIndex = searchIndex ?? null;
    this.broadcast = broadcast ?? null;
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
      if (filename.endsWith(".blocks.json")) return;

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

      // Update search index (text files get markdown-style indexing;
      // extractable containers get extractor output fed into FTS5;
      // opaque binaries like PDF/images only land in the pages table).
      if (!binary) {
        this.searchIndex?.indexPage(relPath, content ?? "", "external");
      } else {
        this.searchIndex?.upsertPage(relPath, detectPageType(relPath));
        const format = extractableFormat(basename(filePath));
        if (format) {
          const arrayBuffer = buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
          );
          void extract(format, arrayBuffer)
            .then((result) => {
              this.searchIndex?.indexPage(relPath, result.text, "external");
            })
            .catch((err) => {
              console.warn(`FTS extractor failed for ${relPath}:`, err);
            });
        }
      }

      // Broadcast WS event (tree:add or tree:update)
      const isNew = !this.knownPaths.has(filePath);
      this.knownPaths.add(filePath);
      if (this.broadcast) {
        if (isNew) {
          this.broadcast({
            type: "tree:add",
            path: relPath,
            name: basename(relPath),
            fileType: detectPageType(relPath),
          });
        } else {
          this.broadcast({ type: "tree:update", path: relPath, etag: `"${newHash}"` });
        }
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
    this.knownPaths.delete(filePath);

    // Broadcast delete event
    this.broadcast?.({ type: "tree:delete", path: relPath });
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
