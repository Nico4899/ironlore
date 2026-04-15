/**
 * Shared extractor contract for non-text source formats (.docx, .xlsx,
 * .eml, and future additions).
 *
 * Extractors run in two places:
 *  - Client viewers — to render the file contents without a round-trip edit
 *    path. Output feeds sanitized HTML or structured display.
 *  - Server ingestion — to populate FTS5 so agents and Cmd+K search can
 *    find content inside binary container formats.
 *
 * Both consumers see the same function, which keeps "what agents see"
 * identical to "what the user sees."
 */

export interface ExtractedSheet {
  name: string;
  /** Row-major table of cell strings, already stringified from Excel. */
  rows: string[][];
}

export interface EmailHeaders {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  cc?: string;
}

export interface NotebookCell {
  /** "markdown" | "code" | "raw" — preserved from the .ipynb JSON. */
  kind: "markdown" | "code" | "raw";
  /** Source text of the cell, already joined from the JSON source array. */
  source: string;
  /** Text outputs (stdout / stderr / text/plain mime) — code cells only. */
  outputs: string[];
  /** Execution count for code cells, null when never run. */
  executionCount: number | null;
}

export interface ExtractResult {
  /** Plain text — always populated; load-bearing for FTS5 indexing. */
  text: string;
  /** Rendered HTML (sanitize before DOM injection). Populated for .docx. */
  html?: string;
  /** Sheet breakdown for .xlsx. Each sheet capped at 1000 rows per ingest
   *  spec — rendering caps are enforced at the viewer layer. */
  sheets?: ExtractedSheet[];
  /** Parsed headers for .eml. */
  email?: EmailHeaders;
  /** Cells for .ipynb, in notebook order. */
  notebook?: NotebookCell[];
  /** Detected kernel language for .ipynb (e.g. "python", "r"). */
  notebookLanguage?: string;
  /** Non-fatal parse warnings. Extractors must not throw on malformed input. */
  warnings: string[];
}

export type ExtractableFormat = "word" | "excel" | "email" | "notebook";
