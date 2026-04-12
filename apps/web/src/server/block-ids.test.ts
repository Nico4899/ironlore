import { describe, expect, it } from "vitest";
import { assignBlockIds, parseBlocks } from "./block-ids.js";

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
