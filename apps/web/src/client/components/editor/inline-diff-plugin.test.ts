import { Window } from "happy-dom";
import { EditorState, type Transaction } from "prosemirror-state";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingEdit } from "../../stores/editor.js";
import { inlineDiffKey, inlineDiffPlugin, setPendingEdits } from "./inline-diff-plugin.js";
import { wikiMarkdownParser } from "./wiki-markdown.js";

/**
 * inline-diff-plugin tests — Phase-11 Step-3 deliverable.
 *
 * Decoration shape, accept/reject keymap, multi-pending dispatch, and
 * the ledger-mismatch fallback are the contracts worth pinning. The
 * plugin renders ghost widgets via `document.createElement`, so we
 * stand up happy-dom once per file. ProseMirror's EditorState does
 * not need a view — `state.apply(tr)` produces the new state +
 * decoration set without any DOM mount, which is what we want for
 * a fast unit suite.
 */

beforeAll(() => {
  const window = new Window();
  // biome-ignore lint/suspicious/noExplicitAny: happy-dom DOMParser type drift
  globalThis.document = window.document as any;
  // biome-ignore lint/suspicious/noExplicitAny: same — ProseMirror's widget factory calls `document.createElement` directly
  (globalThis as any).window = window;
});

afterAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: tear down the global window we installed
  (globalThis as any).document = undefined;
  // biome-ignore lint/suspicious/noExplicitAny: same
  (globalThis as any).window = undefined;
});

const blockEntries = [
  { id: "blk_01HABCABCABCABCABCABCABCAA", text: "First paragraph." },
  { id: "blk_01HABCABCABCABCABCABCABCAB", text: "Second paragraph." },
  { id: "blk_01HABCABCABCABCABCABCABCAC", text: "Third paragraph." },
];

function buildState(entries = blockEntries) {
  const md = entries.map((e) => e.text).join("\n\n");
  const doc = wikiMarkdownParser.parse(md);
  if (!doc) throw new Error("test fixture failed to parse");
  return {
    state: EditorState.create({
      doc,
      plugins: [
        inlineDiffPlugin({
          getBlockEntries: () => entries,
          onAccept: () => {},
          onReject: () => {},
        }),
      ],
    }),
    entries,
  };
}

function applyMeta(state: EditorState, edits: PendingEdit[]): EditorState {
  return state.apply(state.tr.setMeta(inlineDiffKey, { edits }));
}

const replaceEdit: PendingEdit = {
  toolCallId: "tc-1",
  op: "replace",
  blockId: "blk_01HABCABCABCABCABCABCABCAB",
  pageId: "notes/test.md",
  currentMd: "Second paragraph.",
  proposedMd: "Second paragraph, but rewritten.",
  agentSlug: "editor",
};

const insertEdit: PendingEdit = {
  toolCallId: "tc-2",
  op: "insert",
  blockId: "blk_01HABCABCABCABCABCABCABCAC",
  pageId: "notes/test.md",
  proposedMd: "Brand new paragraph.",
  agentSlug: "editor",
};

const deleteEdit: PendingEdit = {
  toolCallId: "tc-3",
  op: "delete",
  blockId: "blk_01HABCABCABCABCABCABCABCAA",
  pageId: "notes/test.md",
  currentMd: "First paragraph.",
  agentSlug: "editor",
};

describe("inlineDiffPlugin — decoration shape", () => {
  it("starts with an empty decoration set", () => {
    const { state } = buildState();
    const ps = inlineDiffKey.getState(state);
    expect(ps).toBeTruthy();
    expect(ps?.edits).toHaveLength(0);
    expect(ps?.decorations.find()).toHaveLength(0);
  });

  it("renders a strike + ghost widget for replace", () => {
    const { state } = buildState();
    const next = applyMeta(state, [replaceEdit]);
    const ps = inlineDiffKey.getState(next);
    expect(ps?.edits).toHaveLength(1);
    const decs = ps?.decorations.find() ?? [];
    // One inline strike + one widget.
    expect(decs).toHaveLength(2);
    const strike = decs.find((d) => (d.spec as { kind?: string } | null)?.kind === "strike");
    const ghost = decs.find((d) => (d.spec as { kind?: string } | null)?.kind === "ghost");
    expect(strike).toBeDefined();
    expect(ghost).toBeDefined();
  });

  it("renders only a widget for pure inserts", () => {
    const { state } = buildState();
    const next = applyMeta(state, [insertEdit]);
    const decs = inlineDiffKey.getState(next)?.decorations.find() ?? [];
    expect(decs).toHaveLength(1);
    expect((decs[0]?.spec as { kind?: string } | null)?.kind).toBe("ghost");
  });

  it("renders only a strike for pure deletes", () => {
    const { state } = buildState();
    const next = applyMeta(state, [deleteEdit]);
    const decs = inlineDiffKey.getState(next)?.decorations.find() ?? [];
    expect(decs).toHaveLength(1);
    expect((decs[0]?.spec as { kind?: string } | null)?.kind).toBe("strike");
  });

  it("renders multiple pending edits across distinct blocks", () => {
    const { state } = buildState();
    const next = applyMeta(state, [deleteEdit, replaceEdit, insertEdit]);
    const decs = inlineDiffKey.getState(next)?.decorations.find() ?? [];
    // delete: 1 strike. replace: 1 strike + 1 widget. insert: 1 widget.
    expect(decs).toHaveLength(4);
  });

  it("drops a decoration when the target block is no longer in the ledger", () => {
    // Ledger has only blocks A and C — replace points at B which
    //  has been edited away. The plugin silently skips rather than
    //  crashing.
    const trimmedEntries = [blockEntries[0], blockEntries[2]] as Array<{
      id: string;
      text: string;
    }>;
    const { state } = buildState(trimmedEntries);
    const next = applyMeta(state, [replaceEdit]);
    const decs = inlineDiffKey.getState(next)?.decorations.find() ?? [];
    expect(decs).toHaveLength(0);
  });

  it("clears decorations when edits go back to empty", () => {
    const { state } = buildState();
    const withEdit = applyMeta(state, [replaceEdit]);
    expect(inlineDiffKey.getState(withEdit)?.decorations.find()).toHaveLength(2);
    const cleared = applyMeta(withEdit, []);
    expect(inlineDiffKey.getState(cleared)?.decorations.find()).toHaveLength(0);
  });
});

describe("inlineDiffPlugin — meta dispatch", () => {
  it("setPendingEdits dispatches the meta transaction shape the plugin reads", () => {
    // Reach into the plugin via a synthetic `view` — we can't build
    //  a real EditorView in the test environment cheaply, so we
    //  stub `dispatch` and assert the transaction's meta payload.
    const { state } = buildState();
    let captured: { edits?: readonly PendingEdit[] } | undefined;
    const fakeView = {
      state,
      dispatch: (tr: Transaction) => {
        captured = tr.getMeta(inlineDiffKey) as typeof captured;
      },
    } as unknown as Parameters<typeof setPendingEdits>[0];
    setPendingEdits(fakeView, [replaceEdit]);
    expect(captured?.edits).toEqual([replaceEdit]);
  });
});

describe("inlineDiffPlugin — accept/reject callbacks", () => {
  let onAccept: ReturnType<typeof vi.fn>;
  let onReject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onAccept = vi.fn();
    onReject = vi.fn();
  });

  function buildKeyboardState() {
    const md = blockEntries.map((e) => e.text).join("\n\n");
    const doc = wikiMarkdownParser.parse(md);
    if (!doc) throw new Error("test fixture failed to parse");
    return EditorState.create({
      doc,
      plugins: [
        inlineDiffPlugin({
          getBlockEntries: () => blockEntries,
          onAccept,
          onReject,
        }),
      ],
    });
  }

  /** Extract the plugin's handleKeyDown + the plugin instance so the
   *  call can bind the right `this`. ProseMirror's typings declare
   *  `handleKeyDown` as a method of `Plugin`, so a free `handler(view, event)`
   *  call doesn't compile even though the runtime impl is an arrow
   *  function and never reads `this`. */
  function getKeyHandler(state: EditorState) {
    const plugin = state.plugins.find((p) => p.spec.props?.handleKeyDown);
    expect(plugin).toBeTruthy();
    const handler = plugin?.spec.props?.handleKeyDown;
    expect(handler).toBeDefined();
    return (view: { state: EditorState }, event: KeyboardEvent): boolean => {
      // biome-ignore lint/suspicious/noExplicitAny: ProseMirror Plugin `this` type drift; the impl is an arrow function
      return handler?.call(plugin as any, view as any, event) === true;
    };
  }

  it("Tab fires onAccept with the first pending edit when no caret-bound match", () => {
    const state = buildKeyboardState();
    const next = applyMeta(state, [replaceEdit]);
    const fire = getKeyHandler(next);
    const handled = fire({ state: next }, makeKeyEvent("Tab"));
    expect(handled).toBe(true);
    expect(onAccept).toHaveBeenCalledWith(replaceEdit);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("⌘⇧Backspace fires onReject", () => {
    const state = buildKeyboardState();
    const next = applyMeta(state, [insertEdit]);
    const fire = getKeyHandler(next);
    const handled = fire(
      { state: next },
      makeKeyEvent("Backspace", { metaKey: true, shiftKey: true }),
    );
    expect(handled).toBe(true);
    expect(onReject).toHaveBeenCalledWith(insertEdit);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("plain Tab without pending edits is a no-op (passes through)", () => {
    const state = buildKeyboardState(); // no edits
    const fire = getKeyHandler(state);
    const handled = fire({ state }, makeKeyEvent("Tab"));
    expect(handled).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("Shift+Tab is not consumed even with pending edits (out-dent stays alive)", () => {
    const state = buildKeyboardState();
    const next = applyMeta(state, [replaceEdit]);
    const fire = getKeyHandler(next);
    const handled = fire({ state: next }, makeKeyEvent("Tab", { shiftKey: true }));
    expect(handled).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
  });
});

function makeKeyEvent(
  key: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
): KeyboardEvent {
  // ProseMirror only reads .key + the three modifier flags; build a
  //  minimal duck-typed event to avoid pulling in jsdom for keyboard
  //  events. preventDefault is a no-op tracker.
  return {
    key,
    metaKey: modifiers.metaKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
}
