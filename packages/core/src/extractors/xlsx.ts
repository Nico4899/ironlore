import type { ExtractedSheet, ExtractResult } from "./types.js";

/** First-N-rows ingest cap — matches the agent source-ingestion spec. */
const INGEST_ROW_CAP = 1000;

/**
 * Extract sheet contents from an .xlsx buffer.
 *
 * SheetJS returns cell values as `unknown` — we stringify uniformly so the
 * `text` field is directly indexable. Rows beyond INGEST_ROW_CAP are
 * dropped from `text` but preserved in `sheets` for the viewer to scroll.
 */
export async function extractXlsx(buffer: ArrayBuffer): Promise<ExtractResult> {
  const xlsxMod = (await import("xlsx")) as unknown as {
    default?: typeof import("xlsx");
    read?: typeof import("xlsx").read;
    utils?: typeof import("xlsx").utils;
  };
  const xlsx = (xlsxMod.default ?? xlsxMod) as typeof import("xlsx");
  const warnings: string[] = [];

  try {
    const wb = xlsx.read(new Uint8Array(buffer), { type: "array" });
    const sheets: ExtractedSheet[] = [];
    const textChunks: string[] = [];

    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const rows = xlsx.utils.sheet_to_json<unknown[]>(ws, {
        header: 1,
        defval: "",
        raw: false,
      });
      const stringRows: string[][] = rows.map((r) =>
        (r ?? []).map((cell: unknown) => (cell == null ? "" : String(cell))),
      );
      sheets.push({ name, rows: stringRows });
      textChunks.push(`# ${name}`);
      for (const row of stringRows.slice(0, INGEST_ROW_CAP)) {
        textChunks.push(row.join("\t"));
      }
      if (stringRows.length > INGEST_ROW_CAP) {
        warnings.push(
          `sheet '${name}' truncated to ${INGEST_ROW_CAP} rows for indexing ` +
            `(${stringRows.length} total).`,
        );
      }
    }

    return { text: textChunks.join("\n"), sheets, warnings };
  } catch (err) {
    return {
      text: "",
      warnings: [`extract failed: ${(err as Error).message}`],
    };
  }
}
