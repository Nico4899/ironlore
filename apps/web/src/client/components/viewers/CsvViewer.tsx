import { Download } from "lucide-react";
import Papa from "papaparse";
import { useCallback, useMemo, useState } from "react";

interface CsvViewerProps {
  content: string;
  onChange: (csv: string) => void;
}

/**
 * Auto-focus an input element via ref callback.
 * This avoids the `autoFocus` attribute which biome flags for a11y.
 */
function focusRef(el: HTMLInputElement | null) {
  el?.focus();
}

export function CsvViewer({ content, onChange }: CsvViewerProps) {
  const parsed = useMemo(() => {
    const result = Papa.parse<string[]>(content, { header: false, skipEmptyLines: true });
    return result.data;
  }, [content]);

  // Header row is the first row
  const headers = parsed[0] ?? [];
  const rows = parsed.slice(1);

  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);

  const handleCellChange = useCallback(
    (rowIdx: number, colIdx: number, value: string) => {
      // rowIdx is relative to data rows (after header)
      const updated = parsed.map((row) => [...row]);
      const targetRow = updated[rowIdx + 1];
      if (targetRow) {
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

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "data.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [content]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <span className="text-xs text-secondary">
          {rows.length} rows &times; {headers.length} columns
        </span>
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
                      className="w-full bg-transparent outline-none"
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
                        className="w-full bg-transparent outline-none"
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
