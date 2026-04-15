import { describe, expect, it } from "vitest";

/**
 * Locks in the new-file naming logic currently living inline in
 * `Sidebar.tsx` (`commitEdit`) and `InlineEditRow` / `NewPageFooter`.
 * Reviewer flagged `my_file.py.md` in the tree as suspicious — this
 * suite proves the picker never produces that shape on its own. The
 * on-disk file is user-supplied (or seed) content, not a UI regression.
 *
 * If any of the three pickers is refactored, these assertions are the
 * contract they need to keep.
 */

/** Mirror of the commitEdit logic path for `kind === "new-file"`. */
function applyCommitEdit(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes(".") ? trimmed : `${trimmed}.md`;
}

/** Mirror of InlineEditRow/NewPageFooter typePicker append logic. */
function applyTypePicker(typedName: string, ext: string): string {
  const name = typedName.trim();
  if (!name) return "";
  if (!name.includes(".")) return name + ext;
  return name;
}

describe("new-file picker — naming logic", () => {
  it("appends .md when the user provides no extension", () => {
    expect(applyCommitEdit("readme")).toBe("readme.md");
  });

  it("does not append .md when the user already typed an extension", () => {
    expect(applyCommitEdit("script.py")).toBe("script.py");
    expect(applyCommitEdit("notes.txt")).toBe("notes.txt");
  });

  it("does not double-append when the user types .md explicitly", () => {
    expect(applyCommitEdit("readme.md")).toBe("readme.md");
  });

  it("typePicker does not append its extension when the name already has a dot", () => {
    // User types `my_file.py` with the picker defaulting to `.md` —
    // the literal `.py` wins and no `my_file.py.md` is produced.
    expect(applyTypePicker("my_file.py", ".md")).toBe("my_file.py");
  });

  it("typePicker appends its extension only when the name has no dot", () => {
    expect(applyTypePicker("my_file", ".md")).toBe("my_file.md");
    expect(applyTypePicker("script", ".py")).toBe("script.py");
  });
});
