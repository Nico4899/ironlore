import { AUTOSAVE_DEBOUNCE_MS } from "@ironlore/core";
import { useCallback, useEffect, useRef } from "react";
import type { ConflictResponse } from "../lib/api.js";
import { saveCsv, savePage } from "../lib/api.js";
import { useEditorStore } from "../stores/editor.js";

/**
 * Auto-save hook: debounce 500ms after last keystroke → PUT with If-Match
 * → new ETag or 409 → merge UI.
 *
 * The hook watches the editor store's `markdown` and `status` fields.
 * When status is "dirty", it starts a debounce timer. After the timer
 * fires, it sends a PUT with the current ETag. On success, the ETag is
 * updated and status transitions to "clean". On 409, status transitions
 * to "conflict" and the conflict data is passed to the callback.
 */
export function useAutoSave(onConflict: (conflict: ConflictResponse) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConflictRef = useRef(onConflict);
  onConflictRef.current = onConflict;

  const save = useCallback(async () => {
    const { filePath, fileType, markdown, etag, status, setStatus, setEtag } =
      useEditorStore.getState();

    if (!filePath || status !== "dirty") return;

    // Only auto-save markdown and CSV — other types are read-only
    if (fileType !== "markdown" && fileType !== "csv") return;

    setStatus("syncing");

    try {
      const result =
        fileType === "csv"
          ? await saveCsv(filePath, markdown, etag)
          : await savePage(filePath, markdown, etag);

      if ("error" in result && result.error === "Conflict") {
        setStatus("conflict");
        onConflictRef.current(result);
        return;
      }

      // Success
      setEtag((result as { etag: string }).etag);
      setStatus("clean");
    } catch {
      // Network error — stay dirty, retry on next debounce
      setStatus("dirty");
    }
  }, []);

  // Watch for "dirty" status and debounce
  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe((state, prev) => {
      // Only react to status changes to "dirty"
      if (state.status !== "dirty") return;
      if (state.status === prev.status && state.markdown === prev.markdown) return;

      // Clear any pending save
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      // Schedule a new save
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        save();
      }, AUTOSAVE_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [save]);
}
