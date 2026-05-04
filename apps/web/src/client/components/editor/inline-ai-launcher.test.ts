import { describe, expect, it } from "vitest";
import { shouldFireExpand } from "./InlineAIComposerLauncher.js";

/**
 * The inline AI composer launcher (per docs/03-editor.md §Inline AI
 * composer) expands the in-editor composer on `⌘L` / `Ctrl+L`. The
 * keymap must:
 *
 * 1. Fire on Cmd/Ctrl + L (no Shift, no Alt) — the documented chord.
 * 2. Suppress when focus is inside an INPUT / TEXTAREA / contentEditable
 *    surface, so a literal `L` keystroke isn't stolen from the editor /
 *    a search box / a form. Mirrors the sidebar `⌘N` New-page predicate
 *    in `sidebar-newpage-rail.test.ts`.
 * 3. Treat uppercase + lowercase L the same so caps-lock / shift quirks
 *    don't break the chord.
 *
 * Pinning the predicate here so a refactor that loosens (or tightens) the
 * suppression rule fails the test loudly.
 */

describe("InlineAIComposerLauncher — ⌘L expand predicate", () => {
  it("fires on Cmd+L when nothing is focused", () => {
    expect(
      shouldFireExpand(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "l" },
        null,
      ),
    ).toBe(true);
  });

  it("fires on Ctrl+L when nothing is focused (Windows / Linux path)", () => {
    expect(
      shouldFireExpand(
        { metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, key: "l" },
        null,
      ),
    ).toBe(true);
  });

  it("treats uppercase L the same as lowercase (caps-lock / shift quirks)", () => {
    expect(
      shouldFireExpand(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "L" },
        null,
      ),
    ).toBe(true);
  });

  it("does not fire when the user is typing in an INPUT (search boxes etc.)", () => {
    expect(
      shouldFireExpand(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "l" },
        { tagName: "INPUT" },
      ),
    ).toBe(false);
  });

  it("does not fire when the user is typing in a TEXTAREA (the composer itself)", () => {
    expect(
      shouldFireExpand(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "l" },
        { tagName: "TEXTAREA" },
      ),
    ).toBe(false);
  });

  it("does not fire when focus is in a contentEditable surface (the editor)", () => {
    // ProseMirror renders the editor as a contentEditable div; a
    //  literal `L` typed into prose must not get stolen by the
    //  expand chord.
    expect(
      shouldFireExpand(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "l" },
        { tagName: "DIV", isContentEditable: true },
      ),
    ).toBe(false);
  });

  it("does not fire on Cmd+Shift+L (different chord, reserved for future use)", () => {
    expect(
      shouldFireExpand(
        { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: "l" },
        null,
      ),
    ).toBe(false);
  });

  it("does not fire on Cmd+Alt+L (different chord)", () => {
    expect(
      shouldFireExpand(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, key: "l" },
        null,
      ),
    ).toBe(false);
  });

  it("does not fire on a bare 'l' (no modifier — it's just typing)", () => {
    expect(
      shouldFireExpand(
        { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "l" },
        null,
      ),
    ).toBe(false);
  });

  it("does not fire on Cmd+M (different key)", () => {
    expect(
      shouldFireExpand(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "m" },
        null,
      ),
    ).toBe(false);
  });
});
