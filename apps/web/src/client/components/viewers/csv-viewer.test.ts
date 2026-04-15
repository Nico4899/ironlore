import Papa from "papaparse";
import { describe, expect, it } from "vitest";

/**
 * The CSV viewer round-trips edits through PapaParse — these tests
 * lock in the parse + unparse contract the viewer relies on so the
 * autosave path can never silently corrupt user data:
 *
 *   - Editing a cell mutates only that one cell (no row reordering,
 *     no column drift).
 *   - PapaParse's defaults (header: false, skipEmptyLines: true)
 *     handle quoted commas, embedded newlines, and trailing blank
 *     rows the way the viewer expects.
 *
 * The viewer-level rendering is exercised manually via the carousel
 * seed; this suite is the serializer guard against refactors.
 */

function editCell(csv: string, rowIdx: number, colIdx: number, next: string): string {
  const parsed = Papa.parse<string[]>(csv, { header: false, skipEmptyLines: true });
  const grid = parsed.data.map((r) => [...r]);
  const target = grid[rowIdx + 1]; // +1 because rowIdx is data-relative; row 0 is the header
  if (!target) return csv;
  while (target.length <= colIdx) target.push("");
  target[colIdx] = next;
  return Papa.unparse(grid);
}

function editHeader(csv: string, colIdx: number, next: string): string {
  const parsed = Papa.parse<string[]>(csv, { header: false, skipEmptyLines: true });
  const grid = parsed.data.map((r) => [...r]);
  const header = grid[0];
  if (!header) return csv;
  header[colIdx] = next;
  return Papa.unparse(grid);
}

describe("CSV editing — round-trip", () => {
  const SIMPLE = "name,role\nAlice,Engineer\nBob,Designer";

  // Papa.unparse always emits `\r\n` between rows; split on the
  // cross-platform separator so we test content not line endings.
  const splitLines = (csv: string): string[] => csv.split(/\r?\n/);

  it("edits a body cell without disturbing siblings", () => {
    const updated = splitLines(editCell(SIMPLE, 0, 1, "PM"));
    expect(updated[0]).toBe("name,role");
    expect(updated[1]).toBe("Alice,PM");
    expect(updated[2]).toBe("Bob,Designer");
  });

  it("edits a header cell without disturbing data rows", () => {
    const updated = splitLines(editHeader(SIMPLE, 1, "title"));
    expect(updated[0]).toBe("name,title");
    expect(updated[1]).toBe("Alice,Engineer");
    expect(updated[2]).toBe("Bob,Designer");
  });

  it("pads short rows when editing a column past the row's current length", () => {
    const sparse = "a,b,c\n1\n2";
    // First data row starts as `["1"]`; after padding to col index 2
    // and writing "x" it becomes `["1", "", "x"]` → `1,,x`.
    const updated = splitLines(editCell(sparse, 0, 2, "x"));
    expect(updated[1]).toBe("1,,x");
  });

  it("preserves quoted values containing commas", () => {
    const quoted = 'name,note\nAlice,"hello, world"\nBob,plain';
    const updated = editCell(quoted, 0, 1, "edited");
    const parsed = Papa.parse<string[]>(updated, { header: false, skipEmptyLines: true });
    expect(parsed.data[1]).toEqual(["Alice", "edited"]);
    // Bob's row untouched.
    expect(parsed.data[2]).toEqual(["Bob", "plain"]);
  });

  it("preserves embedded newlines via PapaParse's quoting", () => {
    const multiline = 'name,bio\nAlice,"line1\nline2"\nBob,plain';
    const updated = editCell(multiline, 0, 0, "Alicia");
    const parsed = Papa.parse<string[]>(updated, { header: false, skipEmptyLines: true });
    expect(parsed.data[1]).toEqual(["Alicia", "line1\nline2"]);
  });

  it("treats an entirely empty CSV as zero rows", () => {
    const parsed = Papa.parse<string[]>("", { header: false, skipEmptyLines: true });
    expect(parsed.data).toEqual([]);
  });
});
