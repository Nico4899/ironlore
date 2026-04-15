import type { ExtractResult, NotebookCell } from "./types.js";

/**
 * Jupyter notebook JSON shape — we only touch the fields we actually need.
 * The full spec (nbformat 4) has many optional fields; everything not
 * referenced here is ignored rather than validated.
 */
interface RawCell {
  cell_type?: unknown;
  source?: unknown;
  execution_count?: unknown;
  outputs?: unknown;
}

interface RawNotebook {
  cells?: unknown;
  metadata?: {
    kernelspec?: { language?: unknown; name?: unknown };
    language_info?: { name?: unknown };
  };
}

/**
 * Join a Jupyter `source` field into a plain string. The spec allows either
 * a single string or an array of lines (usually each line is `"foo\n"`).
 */
function joinSource(source: unknown): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.map((s) => (typeof s === "string" ? s : "")).join("");
  return "";
}

/**
 * Extract text outputs from a code cell. Jupyter output objects have
 * heterogeneous shapes (`stream`, `execute_result`, `display_data`,
 * `error`); we harvest any plain-text fields and skip images / binaries.
 */
function extractOutputText(outputs: unknown): string[] {
  if (!Array.isArray(outputs)) return [];
  const texts: string[] = [];
  for (const out of outputs) {
    if (!out || typeof out !== "object") continue;
    const o = out as Record<string, unknown>;

    if (typeof o.text !== "undefined") {
      const t = joinSource(o.text);
      if (t) texts.push(t);
    }

    const data = o.data;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      const textPlain = d["text/plain"];
      if (typeof textPlain !== "undefined") {
        const t = joinSource(textPlain);
        if (t) texts.push(t);
      }
    }

    if (typeof o.ename === "string" || typeof o.evalue === "string") {
      const name = typeof o.ename === "string" ? o.ename : "";
      const value = typeof o.evalue === "string" ? o.evalue : "";
      if (name || value) texts.push(`${name}: ${value}`.trim());
    }
  }
  return texts;
}

/**
 * Extract cells and plain text from a Jupyter `.ipynb` buffer.
 *
 * The buffer is parsed as UTF-8 JSON. Malformed notebooks (non-JSON,
 * missing `cells`, etc.) yield a single warning and an empty result
 * rather than throwing — the extractor contract guarantees no-throw for
 * ingestion-path safety.
 */
export async function extractIpynb(buffer: ArrayBuffer): Promise<ExtractResult> {
  const warnings: string[] = [];
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder("utf-8").decode(bytes);

  let nb: RawNotebook;
  try {
    nb = JSON.parse(raw) as RawNotebook;
  } catch {
    warnings.push("ipynb: JSON parse failed");
    return { text: "", notebook: [], warnings };
  }

  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) {
    warnings.push("ipynb: missing `cells` array");
    return { text: "", notebook: [], warnings };
  }

  const cells: NotebookCell[] = [];
  const textParts: string[] = [];

  for (const cellRaw of nb.cells as RawCell[]) {
    if (!cellRaw || typeof cellRaw !== "object") continue;
    const kindRaw = cellRaw.cell_type;
    const kind: NotebookCell["kind"] =
      kindRaw === "markdown" || kindRaw === "code" || kindRaw === "raw" ? kindRaw : "raw";

    const source = joinSource(cellRaw.source);
    const outputs = kind === "code" ? extractOutputText(cellRaw.outputs) : [];
    const executionCount =
      typeof cellRaw.execution_count === "number" ? cellRaw.execution_count : null;

    cells.push({ kind, source, outputs, executionCount });

    if (source) textParts.push(source);
    if (outputs.length > 0) textParts.push(outputs.join("\n"));
  }

  const metadata = nb.metadata ?? {};
  const kernelLang = metadata.kernelspec?.language;
  const infoLang = metadata.language_info?.name;
  const notebookLanguage =
    typeof kernelLang === "string"
      ? kernelLang
      : typeof infoLang === "string"
        ? infoLang
        : undefined;

  return {
    text: textParts.join("\n\n"),
    notebook: cells,
    ...(notebookLanguage ? { notebookLanguage } : {}),
    warnings,
  };
}
