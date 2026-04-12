import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { computeEtag, ForbiddenError, resolveSafe } from "@ironlore/core";
import { PathMutex } from "./mutex.js";
import { Wal } from "./wal.js";

export class EtagMismatchError extends Error {
  override readonly name = "EtagMismatchError";
  constructor(
    public readonly currentEtag: string,
    public readonly providedEtag: string,
    public readonly currentContent: string,
  ) {
    super(`ETag mismatch: expected ${providedEtag}, current is ${currentEtag}`);
  }
}

export { ForbiddenError };

/**
 * StorageWriter — the single write path for all page mutations.
 *
 * Write sequence:
 * 1. Acquire per-path mutex
 * 2. Check ETag against current file hash
 * 3. Append operation to WAL (synchronous, durable)
 * 4. fs.writeFile via tmp-file-and-rename (atomic)
 * 5. Mark WAL entry committed
 * 6. Release mutex
 */
export class StorageWriter {
  private mutex = new PathMutex();
  private wal: Wal;
  private dataRoot: string;

  constructor(projectDir: string) {
    this.dataRoot = join(projectDir, "data");
    this.wal = new Wal(projectDir);
  }

  /**
   * Read a page and return its content + ETag.
   * Path is validated through resolveSafe.
   */
  read(pagePath: string): { content: string; etag: string } {
    const absPath = resolveSafe(this.dataRoot, pagePath);
    const content = readFileSync(absPath, "utf-8");
    const etag = computeEtag(content);
    return { content, etag };
  }

  /**
   * Write a page with ETag-based optimistic concurrency.
   *
   * @param pagePath - Relative path within project data dir
   * @param content - New file content (markdown)
   * @param ifMatch - ETag from the last read (required for existing files)
   * @param author - Author of the change (default: "user")
   * @returns New ETag after write
   * @throws {EtagMismatchError} if the file has been modified since last read
   * @throws {ForbiddenError} if path escapes project root
   */
  async write(
    pagePath: string,
    content: string,
    ifMatch: string | null,
    author = "user",
  ): Promise<{ etag: string }> {
    const absPath = resolveSafe(this.dataRoot, pagePath);
    const relPath = relative(this.dataRoot, absPath);

    return this.mutex.withLock(relPath, async () => {
      // Read current content for ETag comparison
      let preHash: string | null = null;
      try {
        const current = readFileSync(absPath, "utf-8");
        preHash = computeEtag(current);

        // ETag check — no silent last-writer-wins
        if (ifMatch && ifMatch !== preHash) {
          throw new EtagMismatchError(preHash, ifMatch, current);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // New file — no ETag to check
          preHash = null;
        } else {
          throw err;
        }
      }

      const postHash = computeEtag(content);

      // Skip write if content hasn't changed
      if (preHash === postHash) {
        return { etag: postHash };
      }

      // Append to WAL (synchronous, durable before filesystem write)
      const walId = this.wal.append({
        path: relPath,
        op: "write",
        preHash,
        postHash,
        content,
        author,
        message: preHash ? `Update ${relPath}` : `Create ${relPath}`,
      });

      // Atomic write: tmp file + rename
      const dir = dirname(absPath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
      try {
        writeFileSync(tmpPath, content, "utf-8");
        renameSync(tmpPath, absPath);
      } catch (err) {
        // Clean up tmp file on failure
        try {
          unlinkSync(tmpPath);
        } catch {
          // ignore cleanup failure
        }
        throw err;
      }

      // Mark WAL entry committed
      this.wal.markCommitted(walId);

      return { etag: postHash };
    });
  }

  /**
   * Delete a page with ETag check.
   */
  async delete(pagePath: string, ifMatch: string, author = "user"): Promise<void> {
    const absPath = resolveSafe(this.dataRoot, pagePath);
    const relPath = relative(this.dataRoot, absPath);

    return this.mutex.withLock(relPath, async () => {
      const current = readFileSync(absPath, "utf-8");
      const currentEtag = computeEtag(current);

      if (ifMatch !== currentEtag) {
        throw new EtagMismatchError(currentEtag, ifMatch, current);
      }

      const walId = this.wal.append({
        path: relPath,
        op: "delete",
        preHash: currentEtag,
        postHash: null,
        content: null,
        author,
        message: `Delete ${relPath}`,
      });

      unlinkSync(absPath);
      this.wal.markCommitted(walId);
    });
  }

  /**
   * Check if a path exists within the data root.
   */
  exists(pagePath: string): boolean {
    try {
      resolveSafe(this.dataRoot, pagePath);
      readFileSync(resolveSafe(this.dataRoot, pagePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the WAL instance for git worker and crash recovery.
   */
  getWal(): Wal {
    return this.wal;
  }

  /**
   * Get the project data root path.
   */
  getDataRoot(): string {
    return this.dataRoot;
  }

  /**
   * Recover from incomplete writes on startup.
   * Checks uncommitted WAL entries and replays or marks them.
   */
  recover(): { recovered: number; warnings: string[] } {
    const uncommitted = this.wal.getUncommitted();
    let recovered = 0;
    const warnings: string[] = [];

    for (const entry of uncommitted) {
      if (entry.op === "delete") {
        // Deletes are simpler — if file is gone, mark committed
        const absPath = join(this.dataRoot, entry.path);
        try {
          readFileSync(absPath);
          // File still exists — delete didn't happen, replay it
          unlinkSync(absPath);
          this.wal.markCommitted(entry.id);
          recovered++;
        } catch {
          // File already gone — delete succeeded
          this.wal.markCommitted(entry.id);
          recovered++;
        }
        continue;
      }

      // Write operation
      const absPath = join(this.dataRoot, entry.path);
      try {
        const current = readFileSync(absPath, "utf-8");
        const currentHash = computeEtag(current);

        if (currentHash === entry.postHash) {
          // Write completed successfully — just mark committed
          this.wal.markCommitted(entry.id);
          recovered++;
        } else if (currentHash === entry.preHash) {
          // Write didn't happen — replay from WAL content
          if (entry.content !== null) {
            const dir = dirname(absPath);
            mkdirSync(dir, { recursive: true });
            writeFileSync(absPath, entry.content, "utf-8");
            this.wal.markCommitted(entry.id);
            recovered++;
          } else {
            warnings.push(`WAL entry ${entry.id}: no content to replay for ${entry.path}`);
          }
        } else {
          // Neither matches — external edit happened during crash window
          warnings.push(
            `WAL entry ${entry.id}: ${entry.path} hash matches neither pre nor post. ` +
              `Run 'ironlore repair' to resolve.`,
          );
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && entry.content !== null) {
          // File doesn't exist — replay the write
          const dir = dirname(absPath);
          mkdirSync(dir, { recursive: true });
          writeFileSync(absPath, entry.content, "utf-8");
          this.wal.markCommitted(entry.id);
          recovered++;
        } else {
          warnings.push(`WAL entry ${entry.id}: cannot recover ${entry.path}: ${err}`);
        }
      }
    }

    return { recovered, warnings };
  }

  close(): void {
    this.wal.close();
  }
}
