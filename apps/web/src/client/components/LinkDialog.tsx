import { Link as LinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";

interface LinkDialogResult {
  url: string;
  text: string;
}

interface PendingRequest {
  initialText: string;
  resolve: (result: LinkDialogResult | null) => void;
}

let pushFn: ((req: PendingRequest) => void) | null = null;

/**
 * Open the inline link dialog. Returns a promise that resolves with
 * the user's `{ url, text }` choice, or `null` if they cancel.
 *
 * Replaces the legacy `window.prompt("Link URL")` flow used by both
 * the WYSIWYG and source editors. The dialog mounts once globally
 * (see `LinkDialogContainer` in App.tsx); callers don't need props,
 * just `await openLinkDialog({ text })`.
 */
export function openLinkDialog(opts?: { text?: string }): Promise<LinkDialogResult | null> {
  return new Promise((resolve) => {
    if (!pushFn) {
      // Container not mounted yet — degrade gracefully so the editor
      //  command doesn't crash. In practice this only happens during
      //  the first React commit; subsequent calls land in the queue.
      resolve(null);
      return;
    }
    pushFn({ initialText: opts?.text ?? "", resolve });
  });
}

/**
 * Inline link-insertion dialog.
 *
 * Mount once in App.tsx. The editor commands call `openLinkDialog()`
 * which returns a promise; the dialog resolves it on Insert (with
 * `{ url, text }`) or Cancel (with `null`). Two inputs:
 *   · URL (required) — pre-seeded to "https://"
 *   · Text (optional) — pre-seeded to the editor's current selection
 *     so the user can keep their selected text as the link label.
 *
 * Centered modal mirrors `SearchDialog`'s overlay grammar; no DOM
 * positioning math relative to the editor's caret (which would have
 * required hooking into ProseMirror coordsAtPos and CodeMirror
 * coordsAtPos separately). Centered + focus-trapped is a uniform
 * affordance across both editor surfaces.
 */
export function LinkDialogContainer() {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [url, setUrl] = useState("https://");
  const [text, setText] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, pending !== null);

  useEffect(() => {
    pushFn = (req) => {
      setUrl("https://");
      setText(req.initialText);
      setPending(req);
    };
    return () => {
      pushFn = null;
    };
  }, []);

  // When a request lands, focus the URL input next tick so the input
  //  is mounted before we call `.focus()`. Selecting the text after
  //  the protocol lets the user paste over `https://` cleanly.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => {
      const el = urlInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
    return () => clearTimeout(t);
  }, [pending]);

  const close = useCallback(
    (result: LinkDialogResult | null) => {
      if (!pending) return;
      pending.resolve(result);
      setPending(null);
    },
    [pending],
  );

  const submit = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed || trimmed === "https://" || trimmed === "http://") return;
    close({ url: trimmed, text: text.trim() });
  }, [url, text, close]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [close, submit],
  );

  if (!pending) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[20vh]"
      onClick={(e) => {
        if (e.target === overlayRef.current) close(null);
      }}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Insert link"
    >
      <div
        ref={dialogRef}
        className="surface-glass flex w-full flex-col overflow-hidden rounded-md shadow-2xl"
        style={{
          background: "var(--il-slate)",
          border: "1px solid var(--il-border)",
          maxWidth: 480,
        }}
      >
        <div
          className="flex items-center gap-2 px-5 py-3"
          style={{ borderBottom: "1px solid var(--il-border-soft)" }}
        >
          <LinkIcon className="h-4 w-4" style={{ color: "var(--il-blue)" }} />
          <span
            className="font-mono uppercase"
            style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
          >
            Insert link
          </span>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="flex flex-col gap-1">
            <span
              className="font-mono uppercase"
              style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
            >
              URL
            </span>
            <input
              ref={urlInputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full rounded border bg-transparent px-2.5 py-1.5 text-sm text-primary outline-none placeholder:text-tertiary focus:border-ironlore-blue/60"
              style={{
                borderColor: "var(--il-border)",
                fontFamily: "var(--font-mono)",
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span
              className="font-mono uppercase"
              style={{ fontSize: 10.5, letterSpacing: "0.06em", color: "var(--il-text3)" }}
            >
              Text <span style={{ color: "var(--il-text4)" }}>(optional)</span>
            </span>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Link text — defaults to URL when blank"
              className="w-full rounded border bg-transparent px-2.5 py-1.5 text-sm text-primary outline-none placeholder:text-tertiary focus:border-ironlore-blue/60"
              style={{ borderColor: "var(--il-border)" }}
            />
          </label>
        </div>

        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{
            borderTop: "1px solid var(--il-border-soft)",
            background: "var(--il-slate-elev)",
          }}
        >
          <button
            type="button"
            onClick={() => close(null)}
            className="rounded px-3 py-1 text-xs text-secondary outline-none hover:bg-ironlore-slate-hover hover:text-primary focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded border-none bg-ironlore-blue px-3 py-1 text-xs font-medium text-background hover:bg-ironlore-blue-strong"
            style={{ boxShadow: "0 0 10px var(--il-blue-glow)" }}
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
