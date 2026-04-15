import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEtag } from "@ironlore/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { EtagMismatchError, StorageWriter } from "./storage-writer.js";

function makeTmpProject(): string {
  const dir = join(tmpdir(), `ironlore-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

describe("StorageWriter", () => {
  const writers: StorageWriter[] = [];

  function createWriter(): { writer: StorageWriter; projectDir: string } {
    const projectDir = makeTmpProject();
    const writer = new StorageWriter(projectDir);
    writers.push(writer);
    return { writer, projectDir };
  }

  afterEach(() => {
    for (const w of writers) {
      w.close();
    }
    writers.length = 0;
  });

  it("writes a new file and returns an etag", async () => {
    const { writer, projectDir } = createWriter();
    const { etag } = await writer.write("test.md", "# Hello\n", null);

    expect(etag).toMatch(/^"sha256-/);
    const content = readFileSync(join(projectDir, "data", "test.md"), "utf-8");
    expect(content).toBe("# Hello\n");
  });

  it("reads a file with etag", async () => {
    const { writer, projectDir } = createWriter();
    writeFileSync(join(projectDir, "data", "existing.md"), "content");

    const { content, etag } = writer.read("existing.md");
    expect(content).toBe("content");
    expect(etag).toBe(computeEtag("content"));
  });

  it("rejects write with stale etag", async () => {
    const { writer, projectDir } = createWriter();
    writeFileSync(join(projectDir, "data", "page.md"), "original");

    const staleEtag = computeEtag("something else");
    await expect(writer.write("page.md", "updated", staleEtag)).rejects.toThrow(EtagMismatchError);

    // Content should be unchanged
    const content = readFileSync(join(projectDir, "data", "page.md"), "utf-8");
    expect(content).toBe("original");
  });

  it("accepts write with correct etag", async () => {
    const { writer, projectDir } = createWriter();
    writeFileSync(join(projectDir, "data", "page.md"), "original");

    const currentEtag = computeEtag("original");
    const { etag } = await writer.write("page.md", "updated", currentEtag);

    expect(etag).toBe(computeEtag("updated"));
    const content = readFileSync(join(projectDir, "data", "page.md"), "utf-8");
    expect(content).toBe("updated");
  });

  it("skips write when content is unchanged", async () => {
    const { writer, projectDir } = createWriter();
    writeFileSync(join(projectDir, "data", "page.md"), "same");

    const currentEtag = computeEtag("same");
    const { etag } = await writer.write("page.md", "same", currentEtag);

    expect(etag).toBe(currentEtag);
  });

  it("creates parent directories for nested paths", async () => {
    const { writer, projectDir } = createWriter();
    await writer.write("sub/dir/page.md", "nested", null);

    const content = readFileSync(join(projectDir, "data", "sub", "dir", "page.md"), "utf-8");
    expect(content).toBe("nested");
  });

  it("handles concurrent writes to same path (serialized)", async () => {
    const { writer } = createWriter();

    // First write
    await writer.write("page.md", "v1", null);
    const etag1 = computeEtag("v1");

    // Two concurrent writes — one should win, one should get 409
    const p1 = writer.write("page.md", "v2", etag1);
    const p2 = writer.write("page.md", "v3", etag1);

    const results = await Promise.allSettled([p1, p2]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("handles concurrent writes to different paths (parallel)", async () => {
    const { writer } = createWriter();

    const results = await Promise.all([
      writer.write("a.md", "content-a", null),
      writer.write("b.md", "content-b", null),
      writer.write("c.md", "content-c", null),
    ]);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.etag).toMatch(/^"sha256-/);
    }
  });

  it("deletes a file with correct etag", async () => {
    const { writer, projectDir } = createWriter();
    writeFileSync(join(projectDir, "data", "delete-me.md"), "bye");

    const etag = computeEtag("bye");
    await writer.delete("delete-me.md", etag);

    expect(() => readFileSync(join(projectDir, "data", "delete-me.md"))).toThrow();
  });

  it("rejects delete with stale etag", async () => {
    const { writer, projectDir } = createWriter();
    writeFileSync(join(projectDir, "data", "keep.md"), "keep me");

    await expect(writer.delete("keep.md", '"sha256-wrong"')).rejects.toThrow(EtagMismatchError);

    // File should still exist
    expect(readFileSync(join(projectDir, "data", "keep.md"), "utf-8")).toBe("keep me");
  });

  describe("readRaw", () => {
    it("reads a binary file and returns buffer + etag", () => {
      const { writer, projectDir } = createWriter();
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
      writeFileSync(join(projectDir, "data", "image.png"), binary);

      const { buffer, etag } = writer.readRaw("image.png");
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer).toEqual(binary);
      expect(etag).toBe(computeEtag(binary));
    });

    it("throws ENOENT for missing file", () => {
      const { writer } = createWriter();
      expect(() => writer.readRaw("missing.png")).toThrow();
    });

    it("rejects path traversal attempts", () => {
      const { writer } = createWriter();
      expect(() => writer.readRaw("../../etc/passwd")).toThrow();
    });
  });

  describe("moveDir", () => {
    it("moves a page directory and all its assets atomically", async () => {
      const { writer, projectDir } = createWriter();
      const dataRoot = join(projectDir, "data");
      mkdirSync(join(dataRoot, "carousel", "assets"), { recursive: true });
      writeFileSync(join(dataRoot, "carousel", "index.md"), "# Carousel\nbody\n");
      writeFileSync(join(dataRoot, "carousel", "assets", "photo.png"), Buffer.from([0, 1, 2]));

      const { etag, movedFiles } = await writer.moveDir("carousel", "examples/carousel");

      expect(etag).toBe(computeEtag("# Carousel\nbody\n"));
      expect(existsSync(join(dataRoot, "carousel"))).toBe(false);
      expect(existsSync(join(dataRoot, "examples", "carousel", "index.md"))).toBe(true);
      expect(existsSync(join(dataRoot, "examples", "carousel", "assets", "photo.png"))).toBe(true);

      const moved = new Set(movedFiles.map((m) => `${m.oldRel} → ${m.newRel}`));
      expect(moved).toContain("carousel/index.md → examples/carousel/index.md");
      expect(moved).toContain("carousel/assets/photo.png → examples/carousel/assets/photo.png");
    });

    it("refuses a move onto an existing destination", async () => {
      const { writer, projectDir } = createWriter();
      const dataRoot = join(projectDir, "data");
      mkdirSync(join(dataRoot, "src"), { recursive: true });
      mkdirSync(join(dataRoot, "dst"), { recursive: true });
      writeFileSync(join(dataRoot, "src", "index.md"), "src");
      writeFileSync(join(dataRoot, "dst", "index.md"), "dst");

      await expect(writer.moveDir("src", "dst")).rejects.toThrow(/already exists/);
      // Source still intact.
      expect(readFileSync(join(dataRoot, "src", "index.md"), "utf-8")).toBe("src");
    });

    it("refuses to move a single file (not a directory)", async () => {
      const { writer, projectDir } = createWriter();
      writeFileSync(join(projectDir, "data", "note.md"), "hi");

      await expect(writer.moveDir("note.md", "other.md")).rejects.toThrow(/Not a directory/);
    });

    it("honours an If-Match etag on index.md", async () => {
      const { writer, projectDir } = createWriter();
      const dataRoot = join(projectDir, "data");
      mkdirSync(join(dataRoot, "page"), { recursive: true });
      writeFileSync(join(dataRoot, "page", "index.md"), "original");
      const stale = computeEtag("something else");

      await expect(writer.moveDir("page", "moved", stale)).rejects.toThrow(EtagMismatchError);
      expect(existsSync(join(dataRoot, "page", "index.md"))).toBe(true);
      expect(existsSync(join(dataRoot, "moved"))).toBe(false);
    });

    it("writes one WAL entry pair per moved file for git attribution", async () => {
      const { writer, projectDir } = createWriter();
      const dataRoot = join(projectDir, "data");
      mkdirSync(join(dataRoot, "folder", "sub"), { recursive: true });
      writeFileSync(join(dataRoot, "folder", "index.md"), "a");
      writeFileSync(join(dataRoot, "folder", "sub", "nested.md"), "b");

      await writer.moveDir("folder", "renamed");

      // Each moved file produces a delete+write WAL pair. Both are
      // already committed, so getCommittedPending includes them.
      const pending = writer.getWal().getCommittedPending(100);
      const paths = pending.map((e) => `${e.op}:${e.path}`);
      expect(paths).toContain("delete:folder/index.md");
      expect(paths).toContain("write:renamed/index.md");
      expect(paths).toContain("delete:folder/sub/nested.md");
      expect(paths).toContain("write:renamed/sub/nested.md");
    });
  });

  describe("crash recovery", () => {
    it("replays uncommitted writes", async () => {
      const { writer, projectDir } = createWriter();

      // Manually insert an uncommitted WAL entry
      const wal = writer.getWal();
      const content = "# Recovered\n";
      wal.append({
        path: "recovered.md",
        op: "write",
        preHash: null,
        postHash: computeEtag(content),
        content,
        author: "user",
        message: "Create recovered.md",
      });

      // Create a new writer to simulate restart + recovery
      writer.close();
      const writer2 = new StorageWriter(projectDir);
      writers.push(writer2);

      const { recovered, warnings } = writer2.recover();
      expect(recovered).toBe(1);
      expect(warnings).toHaveLength(0);

      const fileContent = readFileSync(join(projectDir, "data", "recovered.md"), "utf-8");
      expect(fileContent).toBe(content);
    });
  });
});
