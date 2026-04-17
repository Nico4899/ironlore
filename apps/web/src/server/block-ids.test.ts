import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assignBlockIds, parseBlocks, readBlocksSidecar, writeBlocksSidecar } from "./block-ids.js";

describe("parseBlocks", () => {
  it("detects headings", () => {
    const blocks = parseBlocks("# Title\n\nSome text");
    expect(blocks[0]?.type).toBe("heading");
    expect(blocks[1]?.type).toBe("paragraph");
  });

  it("detects code fences", () => {
    const blocks = parseBlocks("```js\nconst x = 1;\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("code");
  });

  it("detects lists", () => {
    const blocks = parseBlocks("- item 1\n- item 2\n- item 3");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("list");
  });

  it("detects tables", () => {
    const blocks = parseBlocks("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("table");
  });

  it("detects blockquotes", () => {
    const blocks = parseBlocks("> quoted text\n> more quoted");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("blockquote");
  });

  it("detects horizontal rules", () => {
    const blocks = parseBlocks("---");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("hr");
  });

  it("preserves existing block IDs", () => {
    const md = "## Roadmap <!-- #blk_01HY0AEXAMPLEULID0000ABCDE -->";
    const blocks = parseBlocks(md);
    expect(blocks[0]?.id).toBe("blk_01HY0AEXAMPLEULID0000ABCDE");
  });

  it("assigns new IDs to blocks without them", () => {
    const blocks = parseBlocks("# Title\n\nA paragraph.");
    expect(blocks[0]?.id).toMatch(/^blk_[A-Z0-9]{26}$/);
    expect(blocks[1]?.id).toMatch(/^blk_[A-Z0-9]{26}$/);
    expect(blocks[0]?.id).not.toBe(blocks[1]?.id);
  });

  it("handles mixed blocks", () => {
    const md = `# Heading

A paragraph.

- list item 1
- list item 2

\`\`\`
code
\`\`\`

> quote

---

| a | b |
| - | - |`;

    const blocks = parseBlocks(md);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(["heading", "paragraph", "list", "code", "blockquote", "hr", "table"]);
  });
});

describe("assignBlockIds", () => {
  it("injects IDs as HTML comments", () => {
    const { markdown } = assignBlockIds("# Title\n\nParagraph text.");
    expect(markdown).toContain("<!-- #blk_");
    // Should have 2 block IDs (heading + paragraph)
    const matches = markdown.match(/<!-- #blk_[A-Z0-9]{26} -->/g);
    expect(matches).toHaveLength(2);
  });

  it("preserves existing block IDs", () => {
    const original = "## Roadmap <!-- #blk_01HY0AEXAMPLEULID0000ABCDE -->";
    const { markdown } = assignBlockIds(original);
    expect(markdown).toContain("blk_01HY0AEXAMPLEULID0000ABCDE");
    // Should not add a duplicate
    const matches = markdown.match(/<!-- #blk_/g);
    expect(matches).toHaveLength(1);
  });

  it("returns block metadata", () => {
    const { blocks } = assignBlockIds("# Title\n\nText");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("heading");
    expect(blocks[1]?.type).toBe("paragraph");
  });

  it("is idempotent — running twice doesn't add duplicate IDs", () => {
    const { markdown: first } = assignBlockIds("# Title\n\nParagraph.");
    const { markdown: second } = assignBlockIds(first);

    const firstIds = first.match(/<!-- #blk_[A-Z0-9]{26} -->/g) ?? [];
    const secondIds = second.match(/<!-- #blk_[A-Z0-9]{26} -->/g) ?? [];

    expect(firstIds.length).toBe(secondIds.length);
    // Same IDs preserved
    expect(firstIds).toEqual(secondIds);
  });
});

describe("writeBlocksSidecar and readBlocksSidecar", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = join(tmpdir(), `blocks-sidecar-${randomBytes(4).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  it("writes a .blocks.json sidecar next to a .md file", () => {
    const dir = makeTmpDir();
    const mdPath = join(dir, "page.md");
    writeFileSync(mdPath, "# Hello\n");
    const { blocks } = assignBlockIds("# Hello\n");
    writeBlocksSidecar(mdPath, blocks);

    const sidecarPath = join(dir, "page.blocks.json");
    const raw = readFileSync(sidecarPath, "utf-8");
    const parsed = JSON.parse(raw) as { version: number; blocks: Array<{ id: string; type: string }> };
    expect(parsed.version).toBe(1);
    expect(parsed.blocks.length).toBeGreaterThan(0);
    expect(parsed.blocks[0]?.id).toMatch(/^blk_/);
  });

  it("reads back a sidecar it just wrote", () => {
    const dir = makeTmpDir();
    const mdPath = join(dir, "page.md");
    const { blocks } = assignBlockIds("# T\n\nP1\n\nP2\n");
    writeBlocksSidecar(mdPath, blocks);

    const loaded = readBlocksSidecar(mdPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(1);
    expect(loaded?.blocks).toHaveLength(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      expect(loaded?.blocks[i]?.id).toBe(blocks[i]?.id);
      expect(loaded?.blocks[i]?.type).toBe(blocks[i]?.type);
    }
  });

  it("readBlocksSidecar returns null when sidecar is missing", () => {
    const dir = makeTmpDir();
    const mdPath = join(dir, "page.md");
    expect(readBlocksSidecar(mdPath)).toBeNull();
  });

  it("readBlocksSidecar returns null for malformed JSON", () => {
    const dir = makeTmpDir();
    const mdPath = join(dir, "page.md");
    writeFileSync(join(dir, "page.blocks.json"), "{not-json");
    expect(readBlocksSidecar(mdPath)).toBeNull();
  });

  it("sidecar includes start/end offsets per block", () => {
    const dir = makeTmpDir();
    const mdPath = join(dir, "page.md");
    const { blocks } = assignBlockIds("# h1\n\npara 1\n\npara 2\n");
    writeBlocksSidecar(mdPath, blocks);
    const loaded = readBlocksSidecar(mdPath);
    expect(loaded?.blocks[0]).toMatchObject({
      id: expect.any(String),
      type: expect.any(String),
      start: expect.any(Number),
      end: expect.any(Number),
    });
    // offsets monotonically increase
    if (loaded && loaded.blocks.length > 1) {
      expect(loaded.blocks[0]?.end ?? 0).toBeLessThanOrEqual(loaded.blocks[1]?.start ?? 0);
    }
  });

  it("sidecar round-trips a page with existing block IDs", () => {
    const dir = makeTmpDir();
    const mdPath = join(dir, "page.md");
    // Pre-existing block ID on the heading.
    const src = "# T <!-- #blk_01HY7Z8Q9EXISTING00000AAAA -->\n\nBody.\n";
    const { blocks } = assignBlockIds(src);
    writeBlocksSidecar(mdPath, blocks);
    const loaded = readBlocksSidecar(mdPath);
    expect(loaded?.blocks[0]?.id).toBe("blk_01HY7Z8Q9EXISTING00000AAAA");
  });
});
