/**
 * Shared markdown-formatting command surface — the bridge between
 * the editor toolbar (ContentArea) and whichever editor is mounted
 * (`MarkdownEditor` in WYSIWYG mode, `SourceEditor` in Source mode).
 *
 * Each editor registers its own implementation on mount + clears on
 * unmount. The toolbar reads from the module-scoped registry lazily
 * inside its click handlers, so it stays render-safe when no editor
 * is focused (the helper returns `null`, and the buttons are quietly
 * disabled by the caller).
 *
 * The commands themselves are intentionally minimal — they cover the
 * spec toolbar (`B / I / U / ⋯ / H1 / H2 / Quote / Code / Link`) and
 * nothing more. Everything else keeps going through native shortcuts
 * or slash menus.
 */

export interface EditorCommands {
  /** Toggle the `strong` mark on the selection (or wrap with `**…**`). */
  toggleBold(): void;
  /** Toggle the `em` mark on the selection (or wrap with `*…*`). */
  toggleItalic(): void;
  /** Toggle an HTML `<u>…</u>` span — markdown has no native underline. */
  toggleUnderline(): void;
  /** Toggle the strikethrough mark on the selection. */
  toggleStrike(): void;
  /** Toggle the inline `code` mark on the selection. */
  toggleInlineCode(): void;
  /** Promote the current block to a heading of the given level. */
  setHeading(level: 1 | 2 | 3): void;
  /** Wrap the current block in a `blockquote`. */
  toggleBlockquote(): void;
  /** Insert (or wrap) a fenced code block. */
  insertCodeFence(): void;
  /** Insert a link around the selection (prompts for a URL). */
  insertLink(): void;
}

let active: EditorCommands | null = null;

/** Called by each editor on mount; pass `null` to clear on unmount. */
export function registerEditorCommands(next: EditorCommands | null): void {
  active = next;
}

/** Snapshot read — safe to call from toolbar click handlers. */
export function getEditorCommands(): EditorCommands | null {
  return active;
}
