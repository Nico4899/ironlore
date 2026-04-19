import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isSupportedExtension } from "@ironlore/core";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { StorageWriter } from "./storage-writer.js";

/**
 * Upload pipeline — validates, quarantines, sanitizes, and hands off
 * binary file uploads. Every bullet here corresponds to a gate in
 * docs/05-jobs-and-security.md §Upload pipeline. The pipeline is a
 * pure-ish helper (no HTTP framework coupling) so tests can feed
 * bytes + metadata directly.
 *
 * Order of gates matters — cheap rejections first so a malicious
 * upload hits the wall before we do expensive work:
 *
 *   1. Size caps (per file + per request)
 *   2. Extension allowlist (ban `.exe` etc., map to a known PageType)
 *   3. Filename normalization (collision-safe, POSIX-clean)
 *   4. MIME sniff (reject polyglots via `file-type` on first 4 KB)
 *   5. Image re-encoding (sharp strips EXIF/XMP from PNG/JPG/WebP)
 *   6. Quarantine write (data/.uploads/staging/<ulid>)
 *   7. Atomic handoff to StorageWriter's WAL + git commit flow
 */

/** Default caps — overridable per request; read from spec defaults. */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BYTES = 200 * 1024 * 1024;

/**
 * Banned extensions. The ban is redundant with the
 * `isSupportedExtension` allowlist but we keep it explicit so future
 * additions to the allowlist that accidentally include a dangerous
 * type still get caught.
 */
const HARD_BAN_EXTS = new Set([".exe", ".dll", ".msi", ".app", ".bat", ".cmd", ".sh", ".ps1"]);

/** MIME prefixes we re-encode with sharp to strip EXIF + normalize. */
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Staging directory relative to the project's data root. */
const STAGING_SUBDIR = join(".uploads", "staging");

export class UploadRejectedError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "UploadRejectedError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface UploadOptions {
  /** Per-file cap; default 50 MB. */
  maxFileBytes?: number;
  /** Target subdirectory inside `data/`. Empty = project root. */
  targetDir?: string;
}

export interface UploadResult {
  /** Path inside the project's data root, forward-slash separated. */
  path: string;
  /** Size of the file that actually landed (post-re-encode for images). */
  bytes: number;
  /** ETag from the StorageWriter handoff. */
  etag: string;
  /** Detected MIME from `file-type` (null when detection failed). */
  mime: string | null;
  /** True when an image was re-encoded + EXIF-stripped by sharp. */
  reencoded: boolean;
  /** Normalized filename (no path segments). */
  filename: string;
}

/**
 * Run one uploaded file through the pipeline. Throws
 * `UploadRejectedError` on any gate failure; caller maps the error
 * code to an HTTP response.
 *
 * `dataRoot` is `projects/<id>/data/`. All staging + final paths live
 * underneath it — the quarantine flow never writes outside the project.
 */
export async function processUpload(
  filename: string,
  declaredMime: string,
  buffer: Buffer,
  writer: StorageWriter,
  dataRoot: string,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  // Gate 1 — size. The HTTP layer cuts off streams early; this is a
  //  belt + suspenders for callers that pass pre-buffered bytes.
  if (buffer.byteLength === 0) {
    throw new UploadRejectedError("empty", "Empty upload body");
  }
  if (buffer.byteLength > maxBytes) {
    throw new UploadRejectedError(
      "file_too_large",
      `File exceeds ${maxBytes} byte cap (got ${buffer.byteLength})`,
      413,
    );
  }

  // Gate 2 — extension allowlist. Ban the hard-banned set first, then
  //  require an extension the PageType registry knows about. An
  //  unknown extension with no page-type mapping falls through as a
  //  rejection rather than silently writing a random `.bin` blob.
  const baseRaw = basename(filename);
  const ext = extname(baseRaw).toLowerCase();
  if (!ext) {
    throw new UploadRejectedError("no_extension", `Filename needs an extension: ${baseRaw}`);
  }
  if (HARD_BAN_EXTS.has(ext)) {
    throw new UploadRejectedError("banned_extension", `Extension ${ext} is not allowed`);
  }
  if (!isSupportedExtension(baseRaw)) {
    throw new UploadRejectedError(
      "unsupported_extension",
      `Extension ${ext} has no registered page-type viewer`,
    );
  }

  // Gate 3 — filename normalization. Lowercase, strip anything outside
  //  `[a-z0-9._-]`, collapse runs of dashes. Collisions resolve later
  //  via ulid suffix.
  const normalized = normalizeFilename(baseRaw);

  // Gate 4 — MIME sniff via `file-type`. Reads the first 4 KB of the
  //  buffer. Some text-ish types (.md, .csv, .txt, .vtt/.srt) are not
  //  detectable by magic-number sniffing; we whitelist those by
  //  extension and skip the sniff.
  const TEXT_LIKE_EXTS = new Set([
    ".md",
    ".csv",
    ".txt",
    ".log",
    ".vtt",
    ".srt",
    ".mermaid",
    ".mmd",
    ".json",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".c",
    ".h",
    ".cpp",
    ".css",
    ".html",
    ".yaml",
    ".yml",
    ".sql",
    ".svg",
    ".eml",
  ]);
  let sniffedMime: string | null = null;
  if (!TEXT_LIKE_EXTS.has(ext)) {
    const sniff = await fileTypeFromBuffer(buffer.subarray(0, 4096));
    sniffedMime = sniff?.mime ?? null;
    if (!sniffedMime) {
      throw new UploadRejectedError("mime_unknown", `Unable to identify MIME type for ${baseRaw}`);
    }
    // If the client declared a type, it must match the sniffed type.
    //  An empty declaration is tolerated — some clients don't set it.
    if (
      declaredMime &&
      declaredMime !== "application/octet-stream" &&
      !mimeFamilyMatches(declaredMime, sniffedMime)
    ) {
      throw new UploadRejectedError(
        "mime_mismatch",
        `Declared type ${declaredMime} does not match sniffed ${sniffedMime}`,
      );
    }
  }

  // Gate 5 — image re-encoding. Strips EXIF + XMP, normalizes to
  //  progressive encoding. Rejects files that fail to decode — a
  //  `.png` that sharp can't parse is almost certainly a polyglot.
  let finalBuffer = buffer;
  let reencoded = false;
  if (sniffedMime && IMAGE_MIMES.has(sniffedMime)) {
    try {
      const pipeline = sharp(buffer).rotate(); // honor orientation, then strip
      if (sniffedMime === "image/jpeg") {
        finalBuffer = await pipeline.jpeg({ progressive: true, mozjpeg: true }).toBuffer();
      } else if (sniffedMime === "image/png") {
        finalBuffer = await pipeline.png({ progressive: true, compressionLevel: 9 }).toBuffer();
      } else {
        finalBuffer = await pipeline.webp().toBuffer();
      }
      reencoded = true;
    } catch (err) {
      throw new UploadRejectedError(
        "image_decode_failed",
        `Image failed to decode: ${(err as Error).message}`,
      );
    }
  }

  // Gate 6 — quarantine. Write sanitized bytes to
  //  data/.uploads/staging/<ulid>, then rename atomically into the
  //  final path only after StorageWriter has validated resolveSafe
  //  (via writeBinary).
  const stagingRoot = join(dataRoot, STAGING_SUBDIR);
  mkdirSync(stagingRoot, { recursive: true });
  const stagingId = randomBytes(10).toString("hex");
  const stagingPath = join(stagingRoot, stagingId);
  writeFileSync(stagingPath, finalBuffer);

  try {
    // Gate 7 — final path + collision resolution + StorageWriter handoff.
    const targetDir = opts.targetDir?.trim() ?? "";
    const relPath = resolveCollision(dataRoot, targetDir, normalized);
    const { etag } = await writer.writeBinary(relPath, new Uint8Array(finalBuffer));
    return {
      path: relPath,
      bytes: finalBuffer.byteLength,
      etag,
      mime: sniffedMime,
      reencoded,
      filename: normalized,
    };
  } finally {
    // Always clean up staging — even on StorageWriter failure.
    try {
      rmSync(stagingPath, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Sweep stale `.uploads/staging/` entries on server boot. Anything
 * older than 1h is a failed upload the process didn't finish cleaning
 * up; the staging area exists only for the duration of a single
 * `processUpload` call.
 */
export function sweepStagingOnBoot(dataRoot: string, maxAgeMs = 3_600_000): number {
  const stagingRoot = join(dataRoot, STAGING_SUBDIR);
  if (!existsSync(stagingRoot)) return 0;
  let removed = 0;
  const now = Date.now();
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const entry of readdirSync(stagingRoot)) {
      const p = join(stagingRoot, entry);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > maxAgeMs) {
          rmSync(p, { force: true, recursive: true });
          removed++;
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  } catch {
    /* staging unreadable — not fatal */
  }
  return removed;
}

// ─── helpers ──────────────────────────────────────────────────────

/**
 * Normalize a user-supplied filename into `[a-z0-9._-]+` with the
 * original extension preserved. Directory separators and leading dots
 * are stripped so an attacker can't construct a name that escapes the
 * target directory or creates a hidden file.
 */
export function normalizeFilename(name: string): string {
  const raw = basename(name).trim();
  const ext = extname(raw).toLowerCase();
  const stem = raw.slice(0, raw.length - ext.length).toLowerCase();
  const cleanStem = stem
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  const safeStem = cleanStem.length > 0 ? cleanStem : "file";
  return `${safeStem}${ext}`;
}

/**
 * Resolve a collision by appending a short ulid suffix
 * (`name-01HXXX.jpg`) rather than overwriting an existing path.
 * Returns the posix-style relative path the caller should hand to
 * `writer.writeBinary`.
 */
function resolveCollision(dataRoot: string, targetDir: string, filename: string): string {
  const cleanDir = targetDir.replace(/^\/+|\/+$/g, "");
  const firstTry = cleanDir ? `${cleanDir}/${filename}` : filename;
  const abs = join(dataRoot, firstTry);
  if (!existsSync(abs)) return firstTry;

  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 0; i < 5; i++) {
    const suffix = randomBytes(4).toString("hex");
    const candidate = `${stem}-${suffix}${ext}`;
    const candidateRel = cleanDir ? `${cleanDir}/${candidate}` : candidate;
    if (!existsSync(join(dataRoot, candidateRel))) return candidateRel;
  }
  // Ludicrously unlucky — fall through to a timestamp-suffixed name.
  const suffix = Date.now().toString(36);
  const fallback = `${stem}-${suffix}${ext}`;
  return cleanDir ? `${cleanDir}/${fallback}` : fallback;
}

/**
 * Compare a declared MIME (what the client sent) to the sniffed MIME
 * (what `file-type` reports). Browsers often send slightly different
 * canonical forms (`image/jpg` vs `image/jpeg`, `text/plain` for a
 * wide range of types) so we compare permissively.
 */
function mimeFamilyMatches(declared: string, sniffed: string): boolean {
  const d = declared.toLowerCase().split(";")[0]?.trim() ?? "";
  const s = sniffed.toLowerCase();
  if (d === s) return true;
  if (d === "image/jpg" && s === "image/jpeg") return true;
  if (d === "image/pjpeg" && s === "image/jpeg") return true;
  // Same top-level family (image/*, video/*, audio/*) is acceptable.
  //  A `image/png` declared and `image/jpeg` sniffed is still flagged
  //  because we want to reject polyglots. Return true only when the
  //  declaration is a generic family wildcard.
  if (d.endsWith("/*")) return s.startsWith(d.slice(0, -1));
  return false;
}

/**
 * Read a buffered file into memory, respecting the per-file cap.
 * Callers that use `busboy` streams want to accumulate chunks while
 * enforcing the cap incrementally — this helper centralizes that.
 */
export async function bufferStreamWithCap(
  stream: AsyncIterable<Buffer | Uint8Array>,
  cap: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > cap) {
      throw new UploadRejectedError(
        "file_too_large",
        `File exceeds ${cap} byte cap (stream aborted at ${total})`,
        413,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

// Re-export for test ergonomics; keeps the import surface flat.
export { readFileSync as _readFileSync };
export const _HARD_BAN_EXTS = HARD_BAN_EXTS;
export const _STAGING_SUBDIR = STAGING_SUBDIR;
// Silence the unused-import warning when bundlers tree-shake.
void dirname;
