import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlocks } from "@ironlore/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignBlockIds, readBlocksSidecar } from "../block-ids.js";
import { SearchIndex } from "../search-index.js";
import { StorageWriter } from "../storage-writer.js";
import { createKbReplaceBlock } from "./kb-replace-block.js";
import type { ToolCallContext } from "./types.js";

/**
 * D.2 end-to-end coverage through `kb.replace_block`. The unit tests in
 * `block-ids.test.ts` and `writable-kinds-gate.test.ts` cover the
 * helpers in isolation; this file exercises the full tool path so we
 * verify gate + provenance survive the storage-write round-trip.
 */

interface Fixture {
  projectDir: string;
  writer: StorageWriter;
  searchIndex: SearchIndex;
}

function makeFixture(): Fixture {
  const projectDir = join(tmpdir(), `kb-replace-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  const writer = new StorageWriter(projectDir);
  const searchIndex = new SearchIndex(projectDir);
  return { projectDir, writer, searchIndex };
}

function ctx(projectDir: string, agentSlug: string): ToolCallContext {
  return {
    projectId: "main",
    agentSlug,
    jobId: "test",
    emitEvent: () => undefined,
    dataRoot: join(projectDir, "data"),
  };
}

function writePersona(projectDir: string, slug: string, writableKinds: string[]): void {
  const dir = join(projectDir, "data", ".agents", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "persona.md"),
    `---\nslug: ${slug}\nactive: true\nscope:\n  writable_kinds: [${writableKinds.join(", ")}]\n---\n\nbody\n`,
    "utf-8",
  );
}

/**
 * Seed a page through the writer with block IDs already stamped.
 * Mirrors what the HTTP write path does — `StorageWriter.write` itself
 * is content-agnostic, so callers are expected to pre-stamp.
 */
async function seedPage(
  fx: Fixture,
  path: string,
  rawContent: string,
): Promise<{ etag: string; content: string }> {
  const { markdown } = assignBlockIds(rawContent);
  const { etag } = await fx.writer.write(path, markdown, null, "user");
  return { etag, content: markdown };
}

describe("kb.replace_block — D.2 gate + provenance", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.writer.close();
    fx.searchIndex.close();
    rmSync(fx.projectDir, { recursive: true, force: true });
  });

  it("denies a kind:source mutation when writable_kinds excludes source", async () => {
    // Persona scope: page + wiki only. `source` excluded by design.
    writePersona(fx.projectDir, "gardener", ["page", "wiki"]);

    await seedPage(
      fx,
      "src.md",
      "---\nschema: 1\nid: src1\nkind: source\n---\n\n# A\n\nOriginal text.\n",
    );

    // Read it back so we have the parsed block ID.
    const read = fx.writer.read("src.md");
    const blockIdMatch = /<!-- #(blk_[A-Z0-9]{26}) -->/.exec(read.content);
    if (!blockIdMatch?.[1]) throw new Error("expected a block ID after first write");
    const blockId = blockIdMatch[1];

    const tool = createKbReplaceBlock(fx.writer, fx.searchIndex);
    const out = JSON.parse(
      await tool.execute(
        { path: "src.md", blockId, markdown: "Tampered.", etag: read.etag },
        ctx(fx.projectDir, "gardener"),
      ),
    ) as { error?: string; status?: number; ok?: boolean };

    expect(out.ok).toBeUndefined();
    expect(out.status).toBe(403);
    expect(out.error).toContain("kind:source");
    // Source page on disk is unchanged.
    expect(fx.writer.read("src.md").etag).toBe(read.etag);
  });

  it("permits when writable_kinds includes the page's kind", async () => {
    writePersona(fx.projectDir, "ed", ["page", "wiki"]);

    await seedPage(fx, "w.md", "---\nschema: 1\nid: w1\nkind: wiki\n---\n\n# A\n\nOriginal.\n");
    const read = fx.writer.read("w.md");
    const blockId = (/<!-- #(blk_[A-Z0-9]{26}) -->/.exec(read.content) ?? [])[1];
    if (!blockId) throw new Error("expected a block ID");

    const tool = createKbReplaceBlock(fx.writer, fx.searchIndex);
    const out = JSON.parse(
      await tool.execute(
        { path: "w.md", blockId, markdown: "Updated.", etag: read.etag },
        ctx(fx.projectDir, "ed"),
      ),
    ) as { ok?: boolean; newEtag?: string };

    expect(out.ok).toBe(true);
    expect(out.newEtag).toBeTruthy();
    expect(fx.writer.read("w.md").content).toContain("Updated.");
  });

  it("persists derived_from + agent + compiled_at to the .blocks.json sidecar", async () => {
    writePersona(fx.projectDir, "gardener", ["page", "wiki"]);

    await seedPage(fx, "w.md", "---\nid: w1\nkind: wiki\n---\n\n# A\n\nOriginal.\n");
    const read = fx.writer.read("w.md");
    // Locate the body paragraph via the same parser the tool uses,
    // not via raw regex over comment markers — the frontmatter region
    // contains intra-block comment markers that aren't standalone
    // block IDs (parseBlocks merges them into one big paragraph).
    const blocks = parseBlocks(read.content);
    const targetBlock = blocks.find((b) => b.type === "paragraph" && b.text.includes("Original."));
    if (!targetBlock) throw new Error("expected paragraph block");
    const targetId = targetBlock.id;

    const tool = createKbReplaceBlock(fx.writer, fx.searchIndex);
    await tool.execute(
      {
        path: "w.md",
        blockId: targetId,
        markdown: "Synthesised paragraph.",
        etag: read.etag,
        derived_from: ["sources/foo.md#blk_01HSOURCE0000000000000000"],
      },
      ctx(fx.projectDir, "gardener"),
    );

    // Sidecar should now have provenance on the NEW block ID.
    const absPath = join(fx.writer.getDataRoot(), "w.md");
    expect(existsSync(absPath.replace(/\.md$/, ".blocks.json"))).toBe(true);
    const sidecar = readBlocksSidecar(absPath);
    expect(sidecar).not.toBeNull();
    // Find the block whose provenance got stamped (the new para ID).
    const stamped = sidecar?.blocks.find((b) => b.derived_from);
    expect(stamped?.derived_from).toEqual(["sources/foo.md#blk_01HSOURCE0000000000000000"]);
    expect(stamped?.agent).toBe("gardener");
    expect(stamped?.compiled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves provenance on untouched blocks across two edits", async () => {
    writePersona(fx.projectDir, "gardener", ["page", "wiki"]);

    // Page with two paragraphs. Edit one, verify the other's
    // provenance is preserved.
    await seedPage(
      fx,
      "w.md",
      "---\nid: w1\nkind: wiki\n---\n\n# Header\n\nParagraph one.\n\nParagraph two.\n",
    );
    const read1 = fx.writer.read("w.md");
    const blocks1 = parseBlocks(read1.content);
    const para1 = blocks1.find((b) => b.type === "paragraph" && b.text.includes("Paragraph one."));
    const para2 = blocks1.find((b) => b.type === "paragraph" && b.text.includes("Paragraph two."));
    if (!para1 || !para2) throw new Error("expected two paragraph blocks");
    const para1Id = para1.id;
    const para2Id = para2.id;

    const tool = createKbReplaceBlock(fx.writer, fx.searchIndex);

    // First edit: stamps provenance on the replacement of paragraph 1.
    await tool.execute(
      {
        path: "w.md",
        blockId: para1Id,
        markdown: "Synthesised one.",
        etag: read1.etag,
        derived_from: ["sources/a.md#blk_01HSRC100000000000000000"],
      },
      ctx(fx.projectDir, "gardener"),
    );

    // Second edit: replaces paragraph 2. Paragraph-1's provenance must
    // carry forward (its block ID is unchanged, no new stamp).
    const read2 = fx.writer.read("w.md");
    const blocks2 = parseBlocks(read2.content);
    // Paragraph 2's ID survives the first edit (it wasn't touched).
    expect(blocks2.some((b) => b.id === para2Id)).toBe(true);

    await tool.execute(
      {
        path: "w.md",
        blockId: para2Id,
        markdown: "Synthesised two.",
        etag: read2.etag,
        derived_from: ["sources/b.md#blk_01HSRC200000000000000000"],
      },
      ctx(fx.projectDir, "gardener"),
    );

    const absPath = join(fx.writer.getDataRoot(), "w.md");
    const sidecar = readBlocksSidecar(absPath);
    const stamped = sidecar?.blocks.filter((b) => b.derived_from) ?? [];
    // Both replacement paragraphs carry provenance; together they
    // preserve the first edit's stamping.
    expect(stamped.length).toBeGreaterThanOrEqual(2);
    const allDerivedFroms = stamped.flatMap((b) => b.derived_from ?? []);
    expect(allDerivedFroms).toContain("sources/a.md#blk_01HSRC100000000000000000");
    expect(allDerivedFroms).toContain("sources/b.md#blk_01HSRC200000000000000000");
  });

  it("works with no persona file (permissive default)", async () => {
    // No persona at all → gate is permissive → mutation succeeds.
    await seedPage(fx, "w.md", "---\nid: w1\n---\n\n# A\n\nOriginal.\n");
    const read = fx.writer.read("w.md");
    const blockId = (/<!-- #(blk_[A-Z0-9]{26}) -->/.exec(read.content) ?? [])[1];
    if (!blockId) throw new Error("expected block ID");

    const tool = createKbReplaceBlock(fx.writer, fx.searchIndex);
    const out = JSON.parse(
      await tool.execute(
        { path: "w.md", blockId, markdown: "Edit.", etag: read.etag },
        ctx(fx.projectDir, "noscope"),
      ),
    ) as { ok?: boolean };

    expect(out.ok).toBe(true);
  });
});

describe("kb.replace_block — sidecar refresh on tool edits", () => {
  // Pre-D.2, tool-edited pages had stale `.blocks.json` (the sidecar
  // was only refreshed on the HTTP write path). This test pins the
  // fix: after a tool call, the sidecar reflects the current block IDs.
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.writer.close();
    fx.searchIndex.close();
    rmSync(fx.projectDir, { recursive: true, force: true });
  });

  it("writes a sidecar that matches the post-edit content", async () => {
    await seedPage(fx, "w.md", "---\nid: w1\n---\n\n# A\n\nOriginal.\n");
    const read = fx.writer.read("w.md");
    const blockId = (/<!-- #(blk_[A-Z0-9]{26}) -->/.exec(read.content) ?? [])[1];
    if (!blockId) throw new Error("expected block ID");

    const tool = createKbReplaceBlock(fx.writer, fx.searchIndex);
    await tool.execute(
      { path: "w.md", blockId, markdown: "Edit one.\n\nEdit two.", etag: read.etag },
      ctx(fx.projectDir, "ed"),
    );

    const absPath = join(fx.projectDir, "data", "w.md");
    const sidecar = readBlocksSidecar(absPath);
    expect(sidecar).not.toBeNull();
    const fileContent = readFileSync(absPath, "utf-8");
    const liveIds = [...fileContent.matchAll(/<!-- #(blk_[A-Z0-9]{26}) -->/g)].map(
      (m) => m[1] ?? "",
    );
    const sidecarIds = sidecar?.blocks.map((b) => b.id) ?? [];
    // Every block ID in the markdown must appear in the sidecar — no
    // staleness.
    for (const id of liveIds) {
      expect(sidecarIds).toContain(id);
    }
  });
});
