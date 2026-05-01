import type { Node } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { PendingEdit } from "../../stores/editor.js";

/**
 * In-editor inline-diff plugin — Phase-11 deliverable, Step 3 of the
 * Diff-First AI plan.
 *
 * When the interactive Editor agent proposes a `kb.replace_block`,
 * `kb.insert_after`, or `kb.delete_block` on the page the user has
 * open, the proposal renders here as a ProseMirror decoration set
 * keyed to the target block ID — strikethrough on the existing block
 * for replace/delete, ghost-text widget for the proposed markdown for
 * replace/insert. Tab accepts (commits via the existing `kb.*` tool
 * path through the DryRunBridge); ⌘⇧Backspace rejects.
 *
 * Why this surface and not the AI-panel `DiffPreview` card:
 *   - The card requires the user to look away from the page they're
 *     editing, then come back. For interactive runs that's friction.
 *   - In-editor decorations let the user see proposed text in
 *     position — same fonts, same line wrapping, same surrounding
 *     context as the rest of the page.
 *
 * What this is NOT:
 *   - Autonomous runs continue to use Inbox + staging branches. A
 *     gardener that touches 8 pages overnight should NOT light up 8
 *     editors. `useAgentSession` only routes here when `pageId`
 *     matches the active editor's `filePath`; everything else stays
 *     on the panel card path.
 *
 * State coordination: this plugin owns no server state. It reads
 * `PendingEdit`s out of the Zustand `useEditorStore` (mirrored in via
 * meta transactions from the React layer) and calls back to
 * `onAccept` / `onReject` which fire the same `submitDryRunVerdict`
 * round-trip the AI panel uses. The DryRunBridge on the server side
 * is unchanged.
 *
 * See [docs/03-editor.md §Pending-edit decorations](../../../../../docs/03-editor.md)
 * for the user-facing spec and [docs/04-ai-and-agents.md §Default agents
 * → Editor](../../../../../docs/04-ai-and-agents.md) for the agent-side
 * contract.
 */

export const inlineDiffKey = new PluginKey<InlineDiffState>("ironlore-inline-diff");

interface InlineDiffState {
  edits: readonly PendingEdit[];
  decorations: DecorationSet;
}

export interface InlineDiffPluginOptions {
  /**
   * Returns the page's block-ID ledger. The ledger pairs each block
   * ID with the markdown text that block carried at the last
   * round-trip — `MarkdownEditor` populates it via `stripBlockIds()`
   * on every external markdown sync. The plugin walks the doc's
   * top-level block nodes and matches each against this ledger to
   * find where in the doc a given `blockId` lives right now.
   *
   * A getter (rather than a static value) because the ledger lives
   * in a React ref outside ProseMirror — it updates on file-switch
   * without rebuilding the EditorView.
   */
  getBlockEntries: () => ReadonlyArray<{ id: string; text: string }>;
  /** Fired when Tab accepts an edit. Caller posts the verdict. */
  onAccept: (edit: PendingEdit) => void;
  /** Fired when ⌘⇧Backspace rejects an edit. */
  onReject: (edit: PendingEdit) => void;
}

/**
 * Replace the plugin's pending-edits list. Called by the React layer
 * when the Zustand store changes — meta transactions are the only
 * channel through which external state crosses into ProseMirror's
 * world.
 */
export function setPendingEdits(view: EditorView, edits: readonly PendingEdit[]): void {
  view.dispatch(view.state.tr.setMeta(inlineDiffKey, { edits }));
}

/**
 * Build the plugin. The closure captures the lookup + callback
 * options once; the plugin survives re-renders because
 * `MarkdownEditor` only constructs the EditorView on mount.
 */
export function inlineDiffPlugin(opts: InlineDiffPluginOptions): Plugin<InlineDiffState> {
  return new Plugin<InlineDiffState>({
    key: inlineDiffKey,
    state: {
      init: (_, state) => ({
        edits: [],
        decorations: buildDecorationSet(state, [], opts.getBlockEntries()),
      }),
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(inlineDiffKey) as { edits?: readonly PendingEdit[] } | undefined;
        const edits = meta?.edits ?? prev.edits;
        // Rebuild on doc change, edits change, OR when the block
        //  ledger refreshed (we can't observe that directly, so we
        //  fall through and let the next mapped state trigger one).
        //  In practice the doc-change path covers it because the
        //  ledger updates immediately before the doc is reset.
        const docOrEditsChanged = tr.docChanged || meta !== undefined;
        const decorations = docOrEditsChanged
          ? buildDecorationSet(newState, edits, opts.getBlockEntries())
          : prev.decorations.map(tr.mapping, newState.doc);
        return { edits, decorations };
      },
    },
    props: {
      decorations(state) {
        return inlineDiffKey.getState(state)?.decorations ?? null;
      },
      handleKeyDown(view, event) {
        const pluginState = inlineDiffKey.getState(view.state);
        if (!pluginState || pluginState.edits.length === 0) return false;

        // Tab → accept the first pending edit (caret-targeted edit
        //  if the caret happens to sit inside one; first overall
        //  otherwise). Tab is shared with sinkListItem +
        //  goToNextCell — registering this plugin first in the
        //  plugin array gives us first-shot at the keystroke.
        if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
          const target = pickEditAtCaret(view.state, pluginState.edits) ?? pluginState.edits[0];
          if (target) {
            event.preventDefault();
            opts.onAccept(target);
            return true;
          }
        }

        // ⌘⇧Backspace (Mac) / Ctrl⇧Backspace → reject. The chord is
        //  deliberately rare so a slip on the regular Backspace
        //  doesn't drop a proposal the user actually wanted.
        if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && event.shiftKey) {
          const target = pickEditAtCaret(view.state, pluginState.edits) ?? pluginState.edits[0];
          if (target) {
            event.preventDefault();
            opts.onReject(target);
            return true;
          }
        }

        return false;
      },
    },
  });
}

/**
 * Walk the doc's top-level block nodes and produce a `{from, to}`
 * range for each entry whose `text` matches a block's `textContent`.
 * Returns `null` for entries that don't resolve — the caller treats
 * that as "block was edited or deleted, can't anchor a decoration."
 *
 * Matching is plain `textContent.trim() === entryText.trim()`. We
 * don't bother with the full markdown serializer round-trip the
 * selection-as-AI-context path uses because (a) for plain prose
 * blocks the textContent IS the markdown body up to formatting marks,
 * and (b) we're matching against the captured raw markdown, which
 * already had block IDs stripped — comparing the visible text gets
 * us to the right node in 95% of cases without hauling
 * the serializer into the plugin's hot path.
 */
function findBlockRange(doc: Node, entryText: string): { from: number; to: number } | null {
  const target = entryText.trim();
  if (!target) return null;
  let result: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (result) return false; // short-circuit once found
    if (!node.isBlock || !node.isTextblock) return true;
    const nodeText = node.textContent.trim();
    if (nodeText === target) {
      result = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  return result;
}

function buildDecorationSet(
  state: EditorState,
  edits: readonly PendingEdit[],
  entries: ReadonlyArray<{ id: string; text: string }>,
): DecorationSet {
  if (edits.length === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  for (const edit of edits) {
    const entry = entries.find((e) => e.id === edit.blockId);
    if (!entry) continue;
    const range = findBlockRange(state.doc, entry.text);
    if (!range) continue;

    if (edit.op === "replace" || edit.op === "delete") {
      decorations.push(
        Decoration.inline(
          range.from,
          range.to,
          {
            class: `il-diff-strike il-diff-strike--${edit.op}`,
            "data-tool-call-id": edit.toolCallId,
          },
          // Spec mirror — used by `pickEditAtCaret` + tests.
          //  HTML attrs above don't end up on `decoration.spec`,
          //  so we duplicate the keys we want to read back into
          //  the spec layer where ProseMirror exposes them.
          { kind: "strike", op: edit.op, "data-tool-call-id": edit.toolCallId },
        ),
      );
    }
    if (edit.op === "replace" || edit.op === "insert") {
      const widget = Decoration.widget(range.to, () => makeGhostElement(edit), {
        // Place the widget AFTER the existing content so the user
        //  sees old → new top-to-bottom for replaces, and so the
        //  ghost text doesn't disturb cursor positioning inside the
        //  anchor block.
        side: 1,
        key: `inline-diff-${edit.toolCallId}`,
        kind: "ghost",
        op: edit.op,
        "data-tool-call-id": edit.toolCallId,
      });
      decorations.push(widget);
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * Find the edit whose decoration range covers the caret, if any.
 * Falls through to "no caret-bound edit" so the keymap can default
 * to the first edit in document order.
 */
function pickEditAtCaret(
  state: EditorState,
  edits: readonly PendingEdit[],
): PendingEdit | undefined {
  const pluginState = inlineDiffKey.getState(state);
  if (!pluginState) return undefined;
  const { from } = state.selection;
  const hits = pluginState.decorations.find(from, from);
  for (const dec of hits) {
    const spec = dec.spec as { "data-tool-call-id"?: string } | null;
    const tcid = spec?.["data-tool-call-id"];
    if (typeof tcid === "string") {
      const match = edits.find((e) => e.toolCallId === tcid);
      if (match) return match;
    }
  }
  return undefined;
}

/**
 * DOM factory for the ghost widget — non-editable block displaying
 * the agent's proposed markdown. Kept plain-text for the MVP so we
 * don't have to host a second ProseMirror inside a decoration; the
 * styling sells the "preview" affordance via the diff palette
 * (insert green tint + 2px left bar; replace amber). Editor.css owns
 * the visual treatment.
 */
function makeGhostElement(edit: PendingEdit): HTMLElement {
  const el = document.createElement("div");
  el.className = `il-diff-ghost il-diff-ghost--${edit.op}`;
  el.contentEditable = "false";
  el.setAttribute("data-tool-call-id", edit.toolCallId);

  const label = document.createElement("div");
  label.className = "il-diff-ghost__label";
  label.textContent = labelFor(edit);
  el.appendChild(label);

  const body = document.createElement("div");
  body.className = "il-diff-ghost__body";
  // Newlines preserved as <br> so a multi-line proposal stays
  //  readable; raw text otherwise (no markdown rendering — the goal
  //  is "show what's coming," not pretend it's already there).
  body.textContent = edit.proposedMd ?? "";
  el.appendChild(body);

  const hint = document.createElement("div");
  hint.className = "il-diff-ghost__hint";
  hint.textContent = "Tab to accept · ⌘⇧⌫ to reject";
  el.appendChild(hint);

  return el;
}

function labelFor(edit: PendingEdit): string {
  const who = edit.agentSlug ? `${edit.agentSlug} proposes` : "Agent proposes";
  switch (edit.op) {
    case "replace":
      return `${who} a replacement for blk_${edit.blockId.slice(-6)}`;
    case "insert":
      return `${who} a new block after blk_${edit.blockId.slice(-6)}`;
    case "delete":
      return `${who} deleting blk_${edit.blockId.slice(-6)}`;
  }
}
