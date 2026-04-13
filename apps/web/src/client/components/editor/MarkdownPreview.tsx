import { useMemo } from "react";
import { renderMarkdownSafe } from "../../lib/render-markdown-safe.js";
import "./editor.css";

/**
 * Read-only rendered preview of markdown content.
 *
 * This is the ONLY component allowed to use `dangerouslySetInnerHTML` — the
 * biome override in `biome.json` is scoped exclusively to this file. All
 * HTML passes through `renderMarkdownSafe` (rehype-sanitize allow-list)
 * before reaching the DOM.
 *
 * Used as the live preview side pane in source mode.
 */
export function MarkdownPreview({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdownSafe(markdown), [markdown]);

  return (
    <div
      className="ProseMirror flex-1 overflow-y-auto px-8 py-6"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized through renderMarkdownSafe
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
