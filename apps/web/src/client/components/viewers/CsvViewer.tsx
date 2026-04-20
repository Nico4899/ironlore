import { Check, Download, Loader2, Plus } from "lucide-react";
import Papa from "papaparse";
import { useCallback, useMemo, useState } from "react";
import { useEditorStore } from "../../stores/editor.js";

interface CsvViewerProps {
  content: string;
  onChange: (csv: string) => void;
  /** Active file path — used for the download filename. */
  path?: string;
}

/**
 * Auto-focus an input element via ref callback.
 * This avoids the `autoFocus` attribute which biome flags for a11y.
 */
function focusRef(el: HTMLInputElement | null) {
  el?.focus();
}

export function CsvViewer({ content, onChange, path }: CsvViewerProps) {
  const parsed = useMemo(() => {
    const result = Papa.parse<string[]>(content, { header: false, skipEmptyLines: true });
    return result.data;
  }, [content]);

  // Header row is the first row
  const headers = parsed[0] ?? [];
  const rows = parsed.slice(1);

  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);

  // Subscribe to the editor's save status so the toolbar mirrors what
  // the StatusBar shows. Without this the spreadsheet itself never
  // confirms an autosave landed.
  const status = useEditorStore((s) => s.status);

  const seedFirstRow = useCallback(() => {
    // Minimum viable spreadsheet: one header column + one empty row.
    const seeded = Papa.unparse([["Column 1"], [""]]);
    onChange(seeded);
    // Drop the user straight into editing the new header so the next
    // keypress lands somewhere useful.
    setEditingCell({ row: -1, col: 0 });
  }, [onChange]);

  const handleCellChange = useCallback(
    (rowIdx: number, colIdx: number, value: string) => {
      // rowIdx is relative to data rows (after header)
      const updated = parsed.map((row) => [...row]);
      const targetRow = updated[rowIdx + 1];
      if (targetRow) {
        // Pad short rows so the column index is valid
        while (targetRow.length <= colIdx) {
          targetRow.push("");
        }
        targetRow[colIdx] = value;
      }
      const csv = Papa.unparse(updated);
      onChange(csv);
    },
    [parsed, onChange],
  );

  const handleHeaderChange = useCallback(
    (colIdx: number, value: string) => {
      const updated = parsed.map((row) => [...row]);
      const headerRow = updated[0];
      if (headerRow) {
        headerRow[colIdx] = value;
      }
      const csv = Papa.unparse(updated);
      onChange(csv);
    },
    [parsed, onChange],
  );

  // Derive the download filename from the file path. Falls back to a
  // generic name only when no path is available (e.g. during tests).
  const downloadName = path?.split("/").pop() ?? "data.csv";

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(url);
  }, [content, downloadName]);

  // ─── Empty state ─────────────────────────────────────────────────
  // An empty CSV with no rows is a UX dead-end — there's nothing to
  // double-click to start editing. Show a single-button surface that
  // seeds a header + one editable cell. The autosave loop persists
  // the seeded content via the standard CSV write path.
  if (parsed.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="text-center">
          <p className="text-sm text-secondary">This spreadsheet is empty.</p>
          <button
            type="button"
            onClick={seedFirstRow}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-ironlore-blue px-3 py-1.5 text-xs font-semibold text-white hover:bg-ironlore-blue-strong"
          >
            <Plus className="h-3.5 w-3.5" />
            Add first row
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <span className="text-xs text-secondary">
          {rows.length} rows &times; {headers.length} columns
        </span>
        <SaveStatusPill status={status} />
        <div className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-secondary hover:bg-ironlore-slate-hover"
          onClick={handleDownload}
          aria-label="Download CSV"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs">
          <thead className="sticky top-0 bg-ironlore-slate">
            <tr>
              {headers.map((header, colIdx) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: CSV columns have no stable ID
                  key={colIdx}
                  className="cursor-text border border-border px-2 py-1.5 text-left font-medium text-secondary"
                  onDoubleClick={() => setEditingCell({ row: -1, col: colIdx })}
                >
                  {editingCell?.row === -1 && editingCell.col === colIdx ? (
                    <input
                      ref={focusRef}
                      className="w-full bg-transparent font-mono text-xs text-primary outline-none"
                      defaultValue={header}
                      onBlur={(e) => {
                        handleHeaderChange(colIdx, e.currentTarget.value);
                        setEditingCell(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleHeaderChange(colIdx, e.currentTarget.value);
                          setEditingCell(null);
                        }
                        if (e.key === "Escape") setEditingCell(null);
                      }}
                    />
                  ) : (
                    header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: CSV rows have no stable ID
              <tr key={rowIdx} className="hover:bg-ironlore-slate-hover">
                {row.map((cell, colIdx) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: CSV cells have no stable ID
                    key={colIdx}
                    className="cursor-text border border-border px-2 py-1"
                    onDoubleClick={() => setEditingCell({ row: rowIdx, col: colIdx })}
                  >
                    {editingCell?.row === rowIdx && editingCell.col === colIdx ? (
                      <input
                        ref={focusRef}
                        className="w-full bg-transparent font-mono text-xs text-primary outline-none"
                        defaultValue={cell}
                        onBlur={(e) => {
                          handleCellChange(rowIdx, colIdx, e.currentTarget.value);
                          setEditingCell(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleCellChange(rowIdx, colIdx, e.currentTarget.value);
                            setEditingCell(null);
                          }
                          if (e.key === "Escape") setEditingCell(null);
                        }}
                      />
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * In-toolbar mirror of the global StatusBar pill so users get save
 * confirmation without having to look at the bottom of the screen.
 * Hidden when the editor is clean and there's nothing to confirm —
 * we only want to surface it when state is interesting.
 */
function SaveStatusPill({ status }: { status: "clean" | "dirty" | "syncing" | "conflict" }) {
  if (status === "clean") return null;
  const cls = "ml-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]";
  if (status === "syncing") {
    return (
      <span className={`${cls} text-secondary`} role="status" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Saving…
      </span>
    );
  }
  if (status === "conflict") {
    return (
      <span className={`${cls} text-signal-amber`} role="status" aria-live="assertive">
        Conflict
      </span>
    );
  }
  // dirty
  return (
    <span className={`${cls} text-secondary`} role="status" aria-live="polite">
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
      Unsaved
    </span>
  );
}
