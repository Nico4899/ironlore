/**
 * Encode a 2-D string grid into CSV per RFC 4180.
 *
 * Cells are quoted iff they contain a comma, quote, or newline. Embedded
 * quotes are doubled. No BOM is emitted — Ironlore's other text writes
 * don't add one either, and consumers that need one can prepend `\uFEFF`.
 */
export function encodeCsv(rows: string[][]): string {
  return rows.map((row) => row.map(encodeCell).join(",")).join("\n");
}

function encodeCell(cell: string): string {
  if (/[",\n\r]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}
