/**
 * Per-key async mutex. Different keys run in parallel; same key is serialized.
 *
 * Used by StorageWriter to ensure writes to the same file path are ordered
 * while allowing writes to different paths concurrently.
 */
export class PathMutex {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire a lock for the given key, execute fn, then release.
   * Callers for the same key queue behind the current holder.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing lock on this key
    const existing = this.locks.get(key) ?? Promise.resolve();

    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, next);

    try {
      await existing;
      return await fn();
    } finally {
      release?.();
      // Clean up if we're the last waiter
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }
}
