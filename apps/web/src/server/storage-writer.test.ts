import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
