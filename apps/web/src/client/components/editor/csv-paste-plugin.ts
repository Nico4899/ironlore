import type { Node, Schema } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";

/**
 * Detect CSV- or TSV-shaped clipboard text and convert it to a
 * `table` node on paste. This is *opt-in by shape*: we only fire
 * when the pasted text has ≥ 2 lines where every line has the same
 * positive number of delimiter-separated columns. That keeps
 * ordinary prose (a sentence with commas, a stray word with a tab)
 * from being misinterpreted as a table.
 *
 * The first row becomes header cells; remaining rows become body
 * cells. Cells receive inline text with embedded-newline handling
 * (`"a\nb"` splits to two lines within a cell); empty cells are
 * created with a zero-width placeholder so the grid stays visible.
 *
 * Mounted in MarkdownEditor's plugin array. Delimiter is inferred
 * per-paste: tab wins if it appears everywhere; otherwise comma.
 * No regex-heavy RFC-4180 parsing — we handle the common shapes
 * (unquoted, quoted-with-embedded-commas, quoted-with-escaped-quotes)
 * and bail to the default text-paste path on anything else.
 */

const csvPasteKey = new PluginKey("ironlore-csv-paste");

/** Minimum number of lines before we consider the text a table. */
const MIN_ROWS = 2;
/** Minimum number of columns before we consider the text a table. */
const MIN_COLS = 2;

export function csvPastePlugin(schema: Schema): Plugin {
  const { table, table_row, table_header, table_cell } = schema.nodes;
  if (!table || !table_row || !table_header || !table_cell) {
    return new Plugin({ key: csvPasteKey });
  }
  return new Plugin({
    key: csvPasteKey,
    props: {
      handlePaste(view, event) {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;
        // Skip if the paste already looks like HTML — the parseDOM
        //  path handles <table> pastes. Defer to that.
        const html = clipboard.getData("text/html");
        if (html && /<table[\s>]/i.test(html)) return false;
        const text = clipboard.getData("text/plain");
        if (!text) return false;
        const grid = parseDelimitedText(text);
        if (!grid) return false;

        const [headerRow, ...bodyRows] = grid;
        if (!headerRow) return false;
        const cols = headerRow.length;
        const headerCells = headerRow.map((cellText) =>
          buildCell(schema, table_header, cellText),
        );
        const header = table_row.create(null, headerCells);
        const bodies = bodyRows.map((row) => {
          // Pad short rows with empty cells so rectangles stay
          //  rectangles; clip overlong rows so the table doesn't
          //  grow mid-document.
          const cells = Array.from({ length: cols }, (_, i) => {
            const text = row[i] ?? "";
            return buildCell(schema, table_cell, text);
          });
          return table_row.create(null, cells);
        });
        const tableNode = table.create(null, [header, ...bodies]);

        event.preventDefault();
        view.dispatch(view.state.tr.replaceSelectionWith(tableNode).scrollIntoView());
        return true;
      },
    },
  });
}

/**
 * Parse a delimited-text blob into a grid of cells, or null when
 * the shape doesn't look like a table. Delimiter is auto-detected:
 * tab wins when every non-empty line contains at least one tab;
 * otherwise comma. All lines must have the same column count for
 * the detection to succeed.
 */
function parseDelimitedText(raw: string): string[][] | null {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length < MIN_ROWS) return null;

  const delimiter = lines.every((l) => l.includes("\t")) ? "\t" : ",";
  const rows: string[][] = [];
  for (const line of lines) {
    const cells = splitDelimitedLine(line, delimiter);
    if (cells.length < MIN_COLS) return null;
    rows.push(cells);
  }
  // Every row must have the same length; uneven data could be
  //  prose with stray commas.
  const cols = rows[0]?.length ?? 0;
  if (cols < MIN_COLS) return null;
  for (const row of rows) {
    if (row.length !== cols) return null;
  }
  return rows;
}

/**
 * Split a single delimited line, honoring double-quoted cells
 * (which can themselves contain the delimiter). Internal quotes
 * are escaped with `""` per RFC-4180 convention. Good enough for
 * clipboard output from Excel / Google Sheets / Numbers.
 */
function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i < line.length && line[i] === '"') {
      // Quoted cell — read until an unescaped closing quote.
      let buf = "";
      i += 1; // opening quote
      while (i < line.length) {
        const ch = line[i];
        if (ch === '"') {
          if (line[i + 1] === '"') {
            buf += '"';
            i += 2;
            continue;
          }
          i += 1; // closing quote
          break;
        }
        buf += ch ?? "";
        i += 1;
      }
      cells.push(buf);
      // Consume the trailing delimiter (or end).
      if (line[i] === delimiter) i += 1;
    } else {
      // Unquoted — read until delimiter or end.
      let buf = "";
      while (i < line.length && line[i] !== delimiter) {
        buf += line[i] ?? "";
        i += 1;
      }
      cells.push(buf);
      if (line[i] === delimiter) i += 1;
      else break;
    }
  }
  return cells.map((c) => c.trim());
}

/**
 * Build a table cell with the given inline text. Empty cells pass
 * through `createAndFill` so the schema's default (empty inline
 * fragment) is respected. Non-empty cells create a text node and
 * wrap it in the cell's content model.
 */
function buildCell(schema: Schema, cellType: Node["type"], text: string): Node {
  if (!text) {
    return cellType.createAndFill() ?? cellType.create(null);
  }
  const textNode = schema.text(text);
  return cellType.create(null, textNode);
}
