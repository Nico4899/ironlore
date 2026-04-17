import { describe, expect, it } from "vitest";
import { reinsertBlockIds, stripBlockIds } from "./MarkdownEditor.js";

/**
 * Block-ID preservation tests.
 *
 * The editor strips `<!-- #blk_... -->` comments before handing markdown
 * to ProseMirror, then reinserts them on serialize. The pre-fix version
 * used a line-index map: `map.get(5)` → "this block ID belongs on line 5
 * of the output". That silently corrupted IDs whenever the edit changed
 * line counts — inserting a paragraph above an existing block shifted
 * every subsequent line, so every block-ID ended up on the wrong line.
 * The server's `assignBlockIds` preserves pre-existing IDs verbatim, so
 * the corruption stuck.
 *
 * The fix uses a content-based ledger: each stripped entry carries its
 * block text as a fingerprint. Reinsert matches lines to entries by
 * exact text. Unmatched entries drop silently; unmatched lines stay
 * plain for the server to stamp on write.
 */

describe("stripBlockIds", () => {
  it("pulls the block ID off the line and records its text", () => {
    const md = "# Hello <!-- #blk_01HABCABCABCABCABCABCABCAA -->";
    const { cleaned, entries } = stripBlockIds(md);
    expect(cleaned).toBe("# Hello");
    expect(entries).toEqual([{ id: "blk_01HABCABCABCABCABCABCABCAA", text: "# Hello" }]);
  });

  it("strips multiple block-ID comments", () => {
    const md = [
      "# Title <!-- #blk_01HABCABCABCABCABCABCABCAA -->",
      "",
      "Paragraph one. <!-- #blk_01HABCABCABCABCABCABCABCAB -->",
      "",
      "Paragraph two. <!-- #blk_01HABCABCABCABCABCABCABCAC -->",
    ].join("\n");

    const { cleaned, entries } = stripBlockIds(md);
    expect(cleaned).not.toContain("<!-- #blk_");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.text)).toEqual(["# Title", "Paragraph one.", "Paragraph two."]);
  });

  it("leaves markdown without block IDs untouched", () => {
    const md = "# Plain\n\nNo IDs here.\n";
    const { cleaned, entries } = stripBlockIds(md);
    expect(cleaned).toBe(md);
    expect(entries).toEqual([]);
  });

  it("only matches valid 26-char base32 block IDs", () => {
    const md = "# Title <!-- #blk_TOO_SHORT -->"; // wrong shape
    const { cleaned, entries } = stripBlockIds(md);
    // Invalid ID stays in place; nothing stripped.
    expect(cleaned).toBe(md);
    expect(entries).toEqual([]);
  });
});

describe("reinsertBlockIds — content-based matching", () => {
  it("round-trips a pristine (unedited) document", () => {
    const md = [
      "# Title <!-- #blk_01HABCABCABCABCABCABCABCAA -->",
      "",
      "Paragraph. <!-- #blk_01HABCABCABCABCABCABCABCAB -->",
    ].join("\n");

    const { cleaned, entries } = stripBlockIds(md);
    const restored = reinsertBlockIds(cleaned, entries);
    expect(restored).toBe(md);
  });

  it("follows the block when a new paragraph is inserted above it", () => {
    // This is the scenario the line-index version broke on: inserting
    // a line before an existing block shifted the index, so the ID
    // ended up on the wrong line.
    const original = [
      "# Title <!-- #blk_01HABCABCABCABCABCABCABCAA -->",
      "",
      "Existing paragraph. <!-- #blk_01HABCABCABCABCABCABCABCAB -->",
    ].join("\n");

    const { entries } = stripBlockIds(original);
    // After the edit, the user inserted a new paragraph between
    // the heading and the existing paragraph.
    const edited = ["# Title", "", "Brand new paragraph.", "", "Existing paragraph."].join("\n");

    const restored = reinsertBlockIds(edited, entries);

    // The heading keeps its ID.
    expect(restored).toContain("# Title <!-- #blk_01HABCABCABCABCABCABCABCAA -->");
    // The existing paragraph keeps its ID even though its line
    // index shifted from 2 to 4.
    expect(restored).toContain("Existing paragraph. <!-- #blk_01HABCABCABCABCABCABCABCAB -->");
    // The new paragraph stays plain — server will assign an ID on PUT.
    expect(restored).toContain("Brand new paragraph.");
    expect(restored).not.toContain("Brand new paragraph. <!-- #blk_");
  });

  it("follows the block when blocks are reordered", () => {
    const original = [
      "First. <!-- #blk_01HABCABCABCABCABCABCABCAA -->",
      "",
      "Second. <!-- #blk_01HABCABCABCABCABCABCABCAB -->",
    ].join("\n");

    const { entries } = stripBlockIds(original);
    // User reorders: Second now comes before First.
    const edited = ["Second.", "", "First."].join("\n");

    const restored = reinsertBlockIds(edited, entries);
    expect(restored).toContain("Second. <!-- #blk_01HABCABCABCABCABCABCABCAB -->");
    expect(restored).toContain("First. <!-- #blk_01HABCABCABCABCABCABCABCAA -->");
  });

  it("drops IDs whose blocks were deleted", () => {
    const original = [
      "Kept. <!-- #blk_01HABCABCABCABCABCABCABCAA -->",
      "",
      "Deleted. <!-- #blk_01HABCABCABCABCABCABCABCAB -->",
    ].join("\n");

    const { entries } = stripBlockIds(original);
    // User deleted the second paragraph.
    const edited = "Kept.";

    const restored = reinsertBlockIds(edited, entries);
    expect(restored).toBe("Kept. <!-- #blk_01HABCABCABCABCABCABCABCAA -->");
    // blk_AB is silently dropped — it has no matching line anymore.
    expect(restored).not.toContain("blk_01HABCABCABCABCABCABCABCAB");
  });

  it("strips the ID when the block's text was edited", () => {
    const original = "Original text. <!-- #blk_01HABCABCABCABCABCABCABCAA -->";
    const { entries } = stripBlockIds(original);
    const edited = "Modified text.";

    const restored = reinsertBlockIds(edited, entries);
    // Text no longer matches the stored entry → no ID on the line.
    // The server's assignBlockIds will stamp a fresh one on write.
    expect(restored).toBe("Modified text.");
  });

  it("doesn't steal an ID from the same content appearing twice", () => {
    // If two lines have the same stored text, the first match wins
    // and the entry is consumed so the second line stays plain.
    // Without consumption, both would claim the same ID (bug).
    const original = [
      "Same text <!-- #blk_01HABCABCABCABCABCABCABCAA -->",
      "",
      "Different <!-- #blk_01HABCABCABCABCABCABCABCAB -->",
    ].join("\n");

    const { entries } = stripBlockIds(original);
    // User duplicated the first line.
    const edited = ["Same text", "", "Same text", "", "Different"].join("\n");

    const restored = reinsertBlockIds(edited, entries);
    // Only the first "Same text" should carry the ID.
    const firstIdx = restored.indexOf("Same text <!-- #blk_01HABCABCABCABCABCABCABCAA -->");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    // The second "Same text" stays plain.
    const lines = restored.split("\n");
    const taggedCount = lines.filter((l) => l.includes("blk_01HABCABCABCABCABCABCABCAA")).length;
    expect(taggedCount).toBe(1);
  });

  it("returns input unchanged when the ledger is empty", () => {
    const md = "# Nothing to restore\n\nJust text.\n";
    expect(reinsertBlockIds(md, [])).toBe(md);
  });

  it("skips blank lines so empty spacing doesn't claim IDs", () => {
    const original = [
      "A. <!-- #blk_01HABCABCABCABCABCABCABCAA -->",
      "",
      "B. <!-- #blk_01HABCABCABCABCABCABCABCAB -->",
    ].join("\n");
    const { entries } = stripBlockIds(original);

    // Extra blank lines inserted.
    const edited = ["A.", "", "", "", "B."].join("\n");

    const restored = reinsertBlockIds(edited, entries);
    expect(restored.split("\n").filter((l) => l.includes("blk_"))).toHaveLength(2);
  });
});
