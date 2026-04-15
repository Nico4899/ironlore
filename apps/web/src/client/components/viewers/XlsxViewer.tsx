import type { ExtractedSheet } from "@ironlore/core/extractors";
import { useEffect, useState } from "react";
import { createRawFile, fetchRawUrl } from "../../lib/api.js";
import { encodeCsv } from "../../lib/csv-encode.js";
import { useAppStore } from "../../stores/app.js";

/** Max rows rendered per sheet — keeps large workbooks responsive. */
const RENDER_ROW_CAP = 500;

interface XlsxViewerProps {
  path: string;
}

/**
 * Excel workbook viewer.
 *
 * Uses the shared `extractXlsx` extractor so the displayed cells match
 * what gets indexed into FTS5. Sheets show as tabs; large sheets are
 * row-capped at the viewer layer (the ingest cap is enforced in the
 * extractor itself).
 */
export function XlsxViewer({ path }: XlsxViewerProps) {
  const [sheets, setSheets] = useState<ExtractedSheet[] | null>(null);
  const [active, setActive] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setError(null);
    setWarnings([]);
    setActive(0);

    (async () => {
      try {
        const res = await fetch(fetchRawUrl(path));
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        const { extract } = await import("@ironlore/core/extractors");
        const result = await extract("excel", buf);
        if (cancelled) return;
        setSheets(result.sheets ?? []);
        setWarnings(result.warnings);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">Failed to render: {error}</p>
      </div>
    );
  }

  if (sheets === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">Loading workbook...</p>
      </div>
    );
  }

  if (sheets.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">Empty workbook</p>
      </div>
    );
  }

  const current = sheets[active] ?? sheets[0];
  if (!current) return null;
  const visibleRows = current.rows.slice(0, RENDER_ROW_CAP);
  const truncated = current.rows.length > RENDER_ROW_CAP;

  const sheetCsvPath = (sheetName: string) => {
    const slug = sheetName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sheet";
    return path.replace(/\.xlsx$/i, `-${slug}.csv`);
  };

  const handleConvert = async (sheet: ExtractedSheet) => {
    const destination = sheetCsvPath(sheet.name);
    if (!window.confirm(`Create ${destination} from sheet "${sheet.name}"?`)) return;
    try {
      await createRawFile(destination, encodeCsv(sheet.rows));
      useAppStore.getState().setActivePath(destination);
    } catch (err) {
      window.alert(`Convert failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Sheet tabs */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {sheets.map((s, i) => (
          <button
            key={s.name}
            type="button"
            className={`rounded px-2 py-1 text-xs ${
              i === active
                ? "bg-ironlore-slate-hover font-medium"
                : "text-secondary hover:bg-ironlore-slate-hover"
            }`}
            onClick={() => setActive(i)}
            aria-pressed={i === active}
          >
            {s.name}
          </button>
        ))}
        <div className="flex-1" />
        {warnings.length > 0 && (
          <span className="text-xs text-secondary">
            {warnings.length} warning{warnings.length === 1 ? "" : "s"}
          </span>
        )}
        <button
          type="button"
          onClick={() => handleConvert(current)}
          className="rounded border border-border px-2 py-0.5 text-xs text-secondary hover:bg-ironlore-slate-hover"
          title={`Export "${current.name}" as a sibling .csv`}
        >
          Convert to CSV
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <table className="border-collapse text-xs">
          <tbody>
            {visibleRows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: read-only grid, rows never reordered
              <tr key={`r-${r}-${row.length}`}>
                {row.map((cell, c) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: read-only grid, cells never reordered
                    key={`c-${r}-${c}`}
                    className="whitespace-nowrap border border-border px-2 py-1 text-primary"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated && (
          <p className="px-4 py-2 text-xs text-secondary">
            {current.rows.length - RENDER_ROW_CAP} more rows not shown
          </p>
        )}
      </div>
    </div>
  );
}
