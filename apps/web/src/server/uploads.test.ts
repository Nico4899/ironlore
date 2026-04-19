import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageWriter } from "./storage-writer.js";
import {
  _STAGING_SUBDIR,
  bufferStreamWithCap,
  DEFAULT_MAX_FILE_BYTES,
  normalizeFilename,
  processUpload,
  sweepStagingOnBoot,
  UploadRejectedError,
} from "./uploads.js";

/**
 * Phase-8 upload pipeline — gate-by-gate tests.
 *
 * Every gate from docs/05-jobs-and-security.md §Upload pipeline has
 * at least one happy-path and one rejection case. We run against a
 * real StorageWriter + real sharp/file-type so a regression in any
 * dep immediately shows up here rather than at runtime.
 */

function makeTmpProject(): { projectDir: string; dataRoot: string; cleanup: () => void } {
  const projectDir = join(tmpdir(), `uploads-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  const cleanup = () => {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  return { projectDir, dataRoot: join(projectDir, "data"), cleanup };
}

/** Minimal 1×1 PNG produced by sharp — guaranteed to decode cleanly. */
async function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
}

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .jpeg()
    .toBuffer();
}

describe("processUpload — happy paths", () => {
  let ctx: ReturnType<typeof makeTmpProject>;
  let writer: StorageWriter;

  beforeEach(() => {
    ctx = makeTmpProject();
    writer = new StorageWriter(ctx.projectDir);
  });
  afterEach(() => {
    ctx.cleanup();
  });

  it("accepts a valid PNG and hands off to StorageWriter", async () => {
    const png = await makePng();
    const result = await processUpload("cat.png", "image/png", png, writer, ctx.dataRoot);
    expect(result.path).toBe("cat.png");
    expect(result.mime).toBe("image/png");
    expect(result.reencoded).toBe(true);
    expect(existsSync(join(ctx.dataRoot, "cat.png"))).toBe(true);
  });

  it("accepts a valid JPEG and strips EXIF via sharp", async () => {
    // sharp-created JPEG has no EXIF by default; verify re-encoding
    //  still produces a valid file that sharp can round-trip.
    const jpeg = await makeJpeg();
    const result = await processUpload("photo.jpg", "image/jpeg", jpeg, writer, ctx.dataRoot);
    expect(result.reencoded).toBe(true);
    const written = readFileSync(join(ctx.dataRoot, "photo.jpg"));
    // Written file should be a valid JPEG — first two bytes are SOI.
    expect(written[0]).toBe(0xff);
    expect(written[1]).toBe(0xd8);
  });

  it("routes text-like extensions past the MIME sniff gate", async () => {
    const md = Buffer.from("# hello\n");
    const result = await processUpload("notes.md", "text/markdown", md, writer, ctx.dataRoot);
    expect(result.reencoded).toBe(false);
    expect(result.mime).toBeNull();
    expect(readFileSync(join(ctx.dataRoot, "notes.md"), "utf-8")).toBe("# hello\n");
  });

  it("places uploads under the requested targetDir", async () => {
    const md = Buffer.from("body");
    await processUpload("note.md", "text/markdown", md, writer, ctx.dataRoot, {
      targetDir: "engineering",
    });
    expect(existsSync(join(ctx.dataRoot, "engineering", "note.md"))).toBe(true);
  });
});

describe("processUpload — gate rejections", () => {
  let ctx: ReturnType<typeof makeTmpProject>;
  let writer: StorageWriter;

  beforeEach(() => {
    ctx = makeTmpProject();
    writer = new StorageWriter(ctx.projectDir);
  });
  afterEach(() => ctx.cleanup());

  it("rejects empty uploads", async () => {
    await expect(
      processUpload("x.md", "text/markdown", Buffer.alloc(0), writer, ctx.dataRoot),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("rejects files that exceed the per-file cap", async () => {
    const big = Buffer.alloc(1024);
    await expect(
      processUpload("big.md", "text/markdown", big, writer, ctx.dataRoot, {
        maxFileBytes: 512,
      }),
    ).rejects.toMatchObject({ code: "file_too_large", httpStatus: 413 });
  });

  it("rejects files with no extension", async () => {
    await expect(
      processUpload("README", "text/plain", Buffer.from("hi"), writer, ctx.dataRoot),
    ).rejects.toMatchObject({ code: "no_extension" });
  });

  it("rejects hard-banned extensions (.exe)", async () => {
    await expect(
      processUpload(
        "tool.exe",
        "application/octet-stream",
        Buffer.from("MZ"),
        writer,
        ctx.dataRoot,
      ),
    ).rejects.toMatchObject({ code: "banned_extension" });
  });

  it("rejects unknown extensions with no page-type mapping (.xyz)", async () => {
    await expect(
      processUpload(
        "blob.xyz",
        "application/octet-stream",
        Buffer.from("abc"),
        writer,
        ctx.dataRoot,
      ),
    ).rejects.toMatchObject({ code: "unsupported_extension" });
  });

  it("rejects polyglots where sniffed MIME disagrees with declared", async () => {
    // PNG bytes declared as .jpg — sniffer reports image/png but
    //  extension says image/jpeg. Current pipeline sniffs content and
    //  rejects when the declared content-type lies about the payload.
    const png = await makePng();
    await expect(
      processUpload("fake.jpg", "image/jpeg", png, writer, ctx.dataRoot),
    ).rejects.toMatchObject({ code: "mime_mismatch" });
  });

  it("rejects images that fail to decode", async () => {
    // Start with a valid PNG so file-type's sniffer recognizes it as
    //  image/png, then truncate hard. sharp sees an incomplete stream
    //  and throws — exactly the polyglot shape this gate catches.
    const realPng = await makePng();
    const truncated = realPng.subarray(0, 24);
    await expect(
      processUpload("broken.png", "image/png", truncated, writer, ctx.dataRoot),
    ).rejects.toMatchObject({ code: "image_decode_failed" });
  });

  it("rejects content the MIME sniffer can't identify at all", async () => {
    // Give the pipeline an extension that isn't text-like (so the
    //  sniff runs) but bytes the sniffer doesn't recognize.
    const mystery = Buffer.alloc(5000, 0);
    await expect(
      processUpload("blob.pdf", "application/pdf", mystery, writer, ctx.dataRoot),
    ).rejects.toMatchObject({ code: "mime_unknown" });
  });
});

describe("processUpload — quarantine + collisions", () => {
  let ctx: ReturnType<typeof makeTmpProject>;
  let writer: StorageWriter;

  beforeEach(() => {
    ctx = makeTmpProject();
    writer = new StorageWriter(ctx.projectDir);
  });
  afterEach(() => ctx.cleanup());

  it("cleans up the staging file after a successful upload", async () => {
    await processUpload("n.md", "text/markdown", Buffer.from("x"), writer, ctx.dataRoot);
    const stagingRoot = join(ctx.dataRoot, _STAGING_SUBDIR);
    const remaining = existsSync(stagingRoot) ? readdirSync(stagingRoot) : [];
    expect(remaining).toHaveLength(0);
  });

  it("cleans up staging even when StorageWriter rejects the path", async () => {
    // A `..` path makes StorageWriter throw via resolveSafe; staging
    //  file must still be removed.
    await expect(
      processUpload("x.md", "text/markdown", Buffer.from("body"), writer, ctx.dataRoot, {
        targetDir: "../escape",
      }),
    ).rejects.toThrow();
    const stagingRoot = join(ctx.dataRoot, _STAGING_SUBDIR);
    const remaining = existsSync(stagingRoot) ? readdirSync(stagingRoot) : [];
    expect(remaining).toHaveLength(0);
  });

  it("resolves collisions by appending a hex suffix rather than overwriting", async () => {
    await processUpload("dup.md", "text/markdown", Buffer.from("first"), writer, ctx.dataRoot);
    const second = await processUpload(
      "dup.md",
      "text/markdown",
      Buffer.from("second"),
      writer,
      ctx.dataRoot,
    );
    expect(second.path).not.toBe("dup.md");
    expect(second.path).toMatch(/^dup-[a-f0-9]{8}\.md$/);
    expect(readFileSync(join(ctx.dataRoot, "dup.md"), "utf-8")).toBe("first");
  });
});

describe("sweepStagingOnBoot", () => {
  it("removes stale staging entries older than the configured age", () => {
    const ctx = makeTmpProject();
    const stagingRoot = join(ctx.dataRoot, _STAGING_SUBDIR);
    mkdirSync(stagingRoot, { recursive: true });
    const stale = join(stagingRoot, "old");
    const fresh = join(stagingRoot, "new");
    writeFileSync(stale, "leftover");
    writeFileSync(fresh, "recent");
    // Backdate the stale file.
    const { utimesSync } = require("node:fs");
    const twoHoursAgo = (Date.now() - 7_200_000) / 1000;
    utimesSync(stale, twoHoursAgo, twoHoursAgo);

    const removed = sweepStagingOnBoot(ctx.dataRoot);
    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    ctx.cleanup();
  });

  it("is a no-op when staging directory does not exist", () => {
    const ctx = makeTmpProject();
    expect(sweepStagingOnBoot(ctx.dataRoot)).toBe(0);
    ctx.cleanup();
  });
});

describe("normalizeFilename", () => {
  it("lowercases, strips unsafe chars, preserves extension", () => {
    expect(normalizeFilename("My File (final).PNG")).toBe("my-file-final.png");
  });

  it("collapses runs of dashes", () => {
    expect(normalizeFilename("a   b   c.md")).toBe("a-b-c.md");
  });

  it("strips leading/trailing dots and dashes", () => {
    expect(normalizeFilename("...hidden-.md")).toBe("hidden.md");
  });

  it("treats a leading-dot name like `.md` as a dotfile with no extension", () => {
    // Node's `extname('.md')` is '' — leading-dot names are dotfiles,
    //  not typed files. The normalizer strips the leading dot; the
    //  extension gate then rejects the upload because no extension
    //  remains. That's the correct security posture for hidden-file
    //  uploads.
    expect(normalizeFilename(".md")).toBe("md");
  });
});

describe("bufferStreamWithCap", () => {
  it("accumulates all chunks when under the cap", async () => {
    async function* src() {
      yield Buffer.from("hello ");
      yield Buffer.from("world");
    }
    const buf = await bufferStreamWithCap(src(), DEFAULT_MAX_FILE_BYTES);
    expect(buf.toString()).toBe("hello world");
  });

  it("throws mid-stream when the cap is exceeded", async () => {
    async function* src() {
      yield Buffer.alloc(100);
      yield Buffer.alloc(100);
    }
    await expect(bufferStreamWithCap(src(), 150)).rejects.toBeInstanceOf(UploadRejectedError);
  });
});
