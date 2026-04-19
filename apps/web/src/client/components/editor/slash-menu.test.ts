import { describe, expect, it } from "vitest";
import { filterSlashItems, type SlashItem } from "./slash-menu.js";

/**
 * Slash-menu pure-function tests.
 *
 * `filterSlashItems` is what decides which commands appear as the user
 * types `/xxx`. Covers:
 *   - Empty query returns everything (unfiltered list)
 *   - Title substring match (case-insensitive)
 *   - Keyword substring match (so `ol` surfaces `Numbered list` via "ol"
 *     in its keywords)
 *   - Returns [] when nothing matches — the editor uses that to close
 *     the popup instead of showing a stale stale-filtered remnant
 *
 * `getSlashContext` is tested indirectly via the MarkdownEditor —
 * driving it requires a full ProseMirror EditorState. We stick to
 * unit-testable pure helpers here.
 */

// Minimal stubs — we only need the fields filterSlashItems reads.
const stubRun = () => true;
const items: SlashItem[] = [
  {
    title: "Heading 1",
    description: "Large section title",
    icon: null,
    keywords: ["heading", "h1", "title"],
    run: stubRun,
  },
  {
    title: "Heading 2",
    description: "Sub-section",
    icon: null,
    keywords: ["heading", "h2", "subtitle"],
    run: stubRun,
  },
  {
    title: "Numbered list",
    description: "Ordered list",
    icon: null,
    keywords: ["list", "ordered", "ol", "numbered"],
    run: stubRun,
  },
  {
    title: "Bulleted list",
    description: "Unordered list",
    icon: null,
    keywords: ["list", "unordered", "ul", "bullet"],
    run: stubRun,
  },
];

describe("filterSlashItems", () => {
  it("returns everything when query is empty", () => {
    expect(filterSlashItems(items, "")).toHaveLength(items.length);
  });

  it("matches against the title substring", () => {
    const out = filterSlashItems(items, "heading");
    expect(out.map((i) => i.title)).toEqual(["Heading 1", "Heading 2"]);
  });

  it("matches case-insensitively", () => {
    expect(filterSlashItems(items, "HEADING")).toHaveLength(2);
    expect(filterSlashItems(items, "Heading")).toHaveLength(2);
  });

  it("matches against keywords when title doesn't match", () => {
    // "ol" isn't in any title, but it's a keyword on Numbered list.
    const out = filterSlashItems(items, "ol");
    expect(out.map((i) => i.title)).toContain("Numbered list");
  });

  it("matches substrings anywhere in title or keyword (not just prefix)", () => {
    // "dered" hits "Numbered" and "Ordered" via different routes.
    const out = filterSlashItems(items, "dered");
    const titles = new Set(out.map((i) => i.title));
    expect(titles.has("Numbered list")).toBe(true);
  });

  it("returns [] when nothing matches", () => {
    expect(filterSlashItems(items, "xyzzy-no-match")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const snapshot = items.slice();
    filterSlashItems(items, "h1");
    expect(items).toEqual(snapshot);
  });
});
