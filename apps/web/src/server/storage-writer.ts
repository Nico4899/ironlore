import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  computeEtag,
  ForbiddenError,
  type LinkedPathValidator,
  resolveSafe,
} from "@ironlore/core/server";
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
  private mutex: PathMutex;
  private wal: Wal;
  private dataRoot: string;
  private linkedPathValidator?: LinkedPathValidator;

  constructor(projectDir: string, linkedPathValidator?: LinkedPathValidator) {
    this.dataRoot = join(projectDir, "data");
    this.wal = new Wal(projectDir);
    this.mutex = new PathMutex(join(projectDir, ".ironlore", "locks"));
    this.linkedPathValidator = linkedPathValidator;
  }

  /**
   * Read a page and return its content + ETag.
   * Path is validated through resolveSafe.
   */
  read(pagePath: string): { content: string; etag: string } {
    const absPath = resolveSafe(this.dataRoot, pagePath, this.linkedPathValidator);
    const content = readFileSync(absPath, "utf-8");
    const etag = computeEtag(content);
    return { content, etag };
  }

  /**
   * Read a file as a raw Buffer + ETag (for non-text/binary files).
   * Path is validated through resolveSafe.
   */
  readRaw(pagePath: string): { buffer: Buffer; etag: string } {
    const absPath = resolveSafe(this.dataRoot, pagePath, this.linkedPathValidator);
    const buffer = readFileSync(absPath);
    const etag = computeEtag(buffer);
    return { buffer, etag };
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
    const absPath = resolveSafe(this.dataRoot, pagePath, this.linkedPathValidator);
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
   * Delete a page with ETag check. Works for text and binary files.
   * Pass ifMatch=null to skip the check (used by callers that have no
   * cached ETag, e.g. sidebar delete of non-markdown files).
   */
  async delete(pagePath: string, ifMatch: string | null, author = "user"): Promise<void> {
    const absPath = resolveSafe(this.dataRoot, pagePath, this.linkedPathValidator);
    const relPath = relative(this.dataRoot, absPath);

    return this.mutex.withLock(relPath, async () => {
      const currentBuf = readFileSync(absPath);
      const currentEtag = computeEtag(currentBuf);
      const currentText = currentBuf.toString("utf-8");

      if (ifMatch !== null && ifMatch !== currentEtag) {
        throw new EtagMismatchError(currentEtag, ifMatch, currentText);
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
   * Create an empty directory under the data root.
   * Idempotent — succeeds if the directory already exists.
   */
  mkdir(dirPath: string): void {
    const absPath = resolveSafe(this.dataRoot, dirPath, this.linkedPathValidator);
    mkdirSync(absPath, { recursive: true });
  }

  /**
   * Move a directory (including all descendants) atomically.
   *
   * Pages in Ironlore can be either a single `.md` file or a directory
   * (`<page>/index.md + assets/`). The flat-file move path in
   * `pages-api` handles the file case; this method handles the
   * directory case so `<page>/assets/photo.png` travels with the page.
   *
   * Semantics:
   * - `srcRel` must resolve to a real directory (not a symlink, not a
   *   file) inside the project's data root.
   * - `dstRel` must not already exist — callers that want to merge
   *   should walk the tree themselves.
   * - If the directory contains an `index.md`, an optional `ifMatch`
   *   ETag on that file is checked first (optimistic concurrency for
   *   the user-visible page). The bodies of other files are not
   *   ETag-checked — the whole subtree moves as one unit.
   * - The rename itself is a single atomic `renameSync` on the same
   *   filesystem. If it succeeds, the move is durable. WAL entries
   *   are then appended for every file that moved so the git worker
   *   attributes the rename to the calling author.
   *
   * Symlinks (linked repos / linked dirs) are refused — users who
   * want to relocate a mounted link should edit the symlink itself
   * rather than going through the move endpoint.
   */
  async moveDir(
    srcRel: string,
    dstRel: string,
    ifMatch: string | null = null,
    author = "user",
  ): Promise<{ etag: string; movedFiles: Array<{ oldRel: string; newRel: string }> }> {
    const srcAbs = resolveSafe(this.dataRoot, srcRel, this.linkedPathValidator);
    const dstAbs = resolveSafe(this.dataRoot, dstRel, this.linkedPathValidator);

    // lstatSync so we don't follow symlinks silently. A linked-repo /
    // linked-dir page isn't ours to move through this path.
    const srcStat = lstatSync(srcAbs);
    if (srcStat.isSymbolicLink()) {
      throw new Error(`Cannot move a linked directory: ${srcRel}`);
    }
    if (!srcStat.isDirectory()) {
      throw new Error(`Not a directory: ${srcRel}`);
    }
    if (existsSync(dstAbs)) {
      throw new Error(`Destination already exists: ${dstRel}`);
    }

    return this.mutex.withLock(srcRel, async () => {
      // Optional ETag check on the page's index.md.
      const indexAbs = join(srcAbs, "index.md");
      let indexEtag = "";
      if (existsSync(indexAbs)) {
        const content = readFileSync(indexAbs, "utf-8");
        indexEtag = computeEtag(content);
        if (ifMatch && ifMatch !== indexEtag) {
          throw new EtagMismatchError(indexEtag, ifMatch, content);
        }
      }

      // Enumerate every file so we can log one WAL entry pair per
      // rename after the atomic move succeeds.
      const files: Array<{ oldRel: string; newRel: string }> = [];
      const walk = (dirAbs: string, baseOld: string, baseNew: string): void => {
        const entries = readdirSync(dirAbs, { withFileTypes: true });
        for (const entry of entries) {
          const childAbs = join(dirAbs, entry.name);
          const oldRelChild = `${baseOld}/${entry.name}`;
          const newRelChild = `${baseNew}/${entry.name}`;
          if (entry.isDirectory()) {
            walk(childAbs, oldRelChild, newRelChild);
          } else {
            files.push({ oldRel: oldRelChild, newRel: newRelChild });
          }
        }
      };
      walk(srcAbs, srcRel, dstRel);

      // Ensure the destination's parent directory exists, then do the
      // atomic rename. Same-filesystem renames are atomic on POSIX and
      // on Windows for the mv-within-volume case.
      mkdirSync(dirname(dstAbs), { recursive: true });
      renameSync(srcAbs, dstAbs);

      // Paper-trail in the WAL for git author attribution. Committed
      // immediately — the filesystem change is already durable. A
      // crash between renameSync and these appends just loses
      // attribution for the move; the next git flush still records
      // it as a rename via content similarity.
      for (const { oldRel, newRel } of files) {
        const deleteId = this.wal.append({
          path: oldRel,
          op: "delete",
          preHash: null,
          postHash: null,
          content: null,
          author,
          message: `Move: ${oldRel} → ${newRel}`,
        });
        this.wal.markCommitted(deleteId);
        const writeId = this.wal.append({
          path: newRel,
          op: "write",
          preHash: null,
          postHash: null,
          content: null,
          author,
          message: `Move: ${oldRel} → ${newRel}`,
        });
        this.wal.markCommitted(writeId);
      }

      return { etag: indexEtag, movedFiles: files };
    });
  }

  /**
   * Recursively delete a directory and all its contents.
   * No ETag check — the caller is responsible for confirmation.
   * No-op if the path doesn't exist.
   */
  rmdir(dirPath: string): void {
    const absPath = resolveSafe(this.dataRoot, dirPath, this.linkedPathValidator);
    if (!existsSync(absPath)) return;
    const st = statSync(absPath);
    if (!st.isDirectory()) {
      throw new Error(`Not a directory: ${dirPath}`);
    }
    rmSync(absPath, { recursive: true, force: true });
  }

  /**
   * Check if a path exists within the data root.
   */
  exists(pagePath: string): boolean {
    try {
      resolveSafe(this.dataRoot, pagePath, this.linkedPathValidator);
      readFileSync(resolveSafe(this.dataRoot, pagePath, this.linkedPathValidator));
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
   *
   * Returns both:
   *   - `warnings`: flat string messages for console logging + tests.
   *   - `warningsStructured`: `{path, message}` pairs for
   *     `recovery:pending` WS broadcasts and the UI banner.
   * Keeping both shapes avoids a breaking change to the existing
   * call sites that already destructure `{ recovered, warnings }`.
   */
  recover(): {
    recovered: number;
    warnings: string[];
    warningsStructured: Array<{ path: string; message: string }>;
  } {
    const uncommitted = this.wal.getUncommitted();
    let recovered = 0;
    const warnings: string[] = [];
    const warningsStructured: Array<{ path: string; message: string }> = [];
    const warn = (path: string, message: string): void => {
      warnings.push(`WAL entry for ${path}: ${message}`);
      warningsStructured.push({ path, message });
    };

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
            warn(entry.path, `no content to replay (entry ${entry.id})`);
          }
        } else {
          // Neither matches — external edit happened during crash window
          warn(
            entry.path,
            `hash matches neither pre nor post — run 'ironlore repair' to resolve (entry ${entry.id})`,
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
          warn(entry.path, `cannot recover: ${err} (entry ${entry.id})`);
        }
      }
    }

    return { recovered, warnings, warningsStructured };
  }

  close(): void {
    this.wal.close();
  }
}
