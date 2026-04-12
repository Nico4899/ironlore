import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-key async mutex with optional on-disk advisory lock files.
 *
 * Different keys run in parallel; same key is serialized. The in-memory
 * promise chain handles the fast path (intra-process). When a locksDir
 * is provided, an advisory lock file is also created for cross-process
 * visibility (e.g. worker process checking if a path is locked).
 *
 * Used by StorageWriter to ensure writes to the same file path are ordered
 * while allowing writes to different paths concurrently.
 */
export class PathMutex {
  private locks = new Map<string, Promise<void>>();
  private locksDir: string | null;

  constructor(locksDir?: string) {
    this.locksDir = locksDir ?? null;
    if (this.locksDir) {
      mkdirSync(this.locksDir, { recursive: true });
    }
  }

  /**
   * Acquire a lock for the given key, execute fn, then release.
   * Callers for the same key queue behind the current holder.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing lock on this key
    const existing = this.locks.get(key) ?? Promise.resolve();

    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, next);

    let lockFile: string | null = null;

    try {
      await existing;

      // Create advisory lock file for cross-process visibility
      if (this.locksDir) {
        const safeName = key.replace(/[/\\]/g, "__");
        lockFile = join(this.locksDir, `${safeName}.lock`);
        try {
          const fd = openSync(lockFile, "wx");
          closeSync(fd);
        } catch {
          // Lock file already exists from a crashed process — overwrite
          const fd = openSync(lockFile, "w");
          closeSync(fd);
        }
      }

      return await fn();
    } finally {
      // Remove advisory lock file
      if (lockFile) {
        try {
          unlinkSync(lockFile);
        } catch {
          // ignore — file might already be gone
        }
      }

      release?.();
      // Clean up if we're the last waiter
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }
}
