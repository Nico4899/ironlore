import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `BlockProvenanceStrip` carries a `formatRelative(iso)` helper that
 * turns the cited block's `compiled_at` ISO string into a brief human
 * label ("2h ago", "3d ago", "5w ago", or a full ISO date past a
 * year). The strip is used in two surfaces (the toolbar Provenance
 * panel + the citation `ProvenancePane`), so the format must read
 * the same way wherever the user sees it. Pin the contract here as
 * a pure-logic mirror — matches the codebase's existing test
 * convention for inline-helper extraction (see
 * sidebar-newpage-rail.test.ts, folder-peek.test.ts).
 */

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d ago`;
  const weeks = days / 7;
  if (weeks < 52) return `${Math.floor(weeks)}w ago`;
  return iso.slice(0, 10);
}

describe("BlockProvenanceStrip — formatRelative", () => {
  // Pin Date.now() so the relative bands test deterministically.
  const NOW = new Date("2026-05-04T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function ago(ms: number): string {
    return new Date(NOW - ms).toISOString();
  }

  it("returns 'just now' for a stamp in the last minute", () => {
    expect(formatRelative(ago(30 * 1000))).toBe("just now");
    expect(formatRelative(ago(59 * 1000))).toBe("just now");
  });

  it("formats minutes for the first hour", () => {
    expect(formatRelative(ago(2 * 60 * 1000))).toBe("2m ago");
    expect(formatRelative(ago(59 * 60 * 1000))).toBe("59m ago");
  });

  it("formats hours for the first day", () => {
    expect(formatRelative(ago(2 * 60 * 60 * 1000))).toBe("2h ago");
    expect(formatRelative(ago(23 * 60 * 60 * 1000))).toBe("23h ago");
  });

  it("formats days for the first week", () => {
    expect(formatRelative(ago(3 * 24 * 60 * 60 * 1000))).toBe("3d ago");
    expect(formatRelative(ago(6 * 24 * 60 * 60 * 1000))).toBe("6d ago");
  });

  it("formats weeks up to a year", () => {
    expect(formatRelative(ago(2 * 7 * 24 * 60 * 60 * 1000))).toBe("2w ago");
    expect(formatRelative(ago(50 * 7 * 24 * 60 * 60 * 1000))).toBe("50w ago");
  });

  it("falls back to ISO date past 52 weeks", () => {
    const oneYearAgo = ago(53 * 7 * 24 * 60 * 60 * 1000);
    expect(formatRelative(oneYearAgo)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles a future stamp gracefully (clamps to 'just now')", () => {
    // Clock skew between a server stamp + the user's clock shouldn't
    //  produce nonsense like "-3m ago". The Math.max(0, …) guard pins
    //  near-future stamps to the same band as "just now".
    expect(formatRelative(ago(-30 * 1000))).toBe("just now");
  });

  it("returns the input untouched when the ISO is unparseable", () => {
    expect(formatRelative("garbage")).toBe("garbage");
  });
});
