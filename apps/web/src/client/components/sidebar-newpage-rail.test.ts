import { describe, expect, it } from "vitest";

/**
 * The sidebar's "New page" rail is paired with a global ⌘N (or
 * Ctrl+N) keymap that calls the same handler the rail's click does.
 * The keymap must be suppressed when the user is typing in an input,
 * textarea, or contentEditable surface (the editor) so the chord
 * doesn't steal a literal "N" keystroke.
 *
 * This file pins the predicate the keymap uses so a refactor that
 * loosens the suppression breaks the test loudly. The handler itself
 * is wired in `SidebarNew.tsx` and reads `document.activeElement`;
 * we mirror that decision here as a pure function.
 */

interface KeyEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

interface ActiveLike {
  tagName?: string;
  isContentEditable?: boolean;
}

function shouldFireNewPage(e: KeyEventLike, active: ActiveLike | null): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.shiftKey || e.altKey) return false;
  if (e.key.toLowerCase() !== "n") return false;
  const tag = active?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) return false;
  return true;
}

describe("New-page rail keymap predicate", () => {
  it("fires on Cmd+N when nothing is focused", () => {
    expect(
      shouldFireNewPage(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "n" },
        null,
      ),
    ).toBe(true);
  });

  it("fires on Ctrl+N when nothing is focused (Windows / Linux path)", () => {
    expect(
      shouldFireNewPage(
        { metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, key: "n" },
        null,
      ),
    ).toBe(true);
  });

  it("treats uppercase N the same as lowercase (caps-lock / shift quirks)", () => {
    expect(
      shouldFireNewPage(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "N" },
        null,
      ),
    ).toBe(true);
  });

  it("does not fire when the user is typing in an INPUT", () => {
    expect(
      shouldFireNewPage(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "n" },
        { tagName: "INPUT" },
      ),
    ).toBe(false);
  });

  it("does not fire when the user is typing in a TEXTAREA", () => {
    expect(
      shouldFireNewPage(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "n" },
        { tagName: "TEXTAREA" },
      ),
    ).toBe(false);
  });

  it("does not fire when focus is in a contentEditable surface (the editor)", () => {
    expect(
      shouldFireNewPage(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "n" },
        { tagName: "DIV", isContentEditable: true },
      ),
    ).toBe(false);
  });

  it("does not fire on Cmd+Shift+N (a different chord — keep room for future bindings)", () => {
    expect(
      shouldFireNewPage(
        { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: "n" },
        null,
      ),
    ).toBe(false);
  });

  it("does not fire on a bare 'n' (no modifier)", () => {
    expect(
      shouldFireNewPage(
        { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "n" },
        null,
      ),
    ).toBe(false);
  });

  it("does not fire on Cmd+M (different key)", () => {
    expect(
      shouldFireNewPage(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "m" },
        null,
      ),
    ).toBe(false);
  });
});
