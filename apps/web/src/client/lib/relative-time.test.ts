import { describe, expect, it } from "vitest";
import { formatRelative } from "./relative-time.js";

/**
 * `formatRelative` — the shared formatter behind the Agent Detail
 * "last fire" / "next fire" rows and the Inbox entry-header chip.
 * Small, deterministic, pure function; exercise the boundary cases
 * that each consumer depends on.
 */

const NOW = 1_700_000_000_000; // fixed epoch for determinism

describe("formatRelative (past)", () => {
  it('returns "just now" for differences under 5 seconds', () => {
    expect(formatRelative(NOW - 0, NOW)).toBe("just now");
    expect(formatRelative(NOW - 4_999, NOW)).toBe("just now");
  });

  it("renders seconds once the delta clears the 5s window", () => {
    expect(formatRelative(NOW - 5_000, NOW)).toBe("5s ago");
    expect(formatRelative(NOW - 59_000, NOW)).toBe("59s ago");
  });

  it("renders minutes between 1m and 59m", () => {
    expect(formatRelative(NOW - 60_000, NOW)).toBe("1m ago");
    expect(formatRelative(NOW - 59 * 60_000, NOW)).toBe("59m ago");
  });

  it("renders hours between 1h and 23h", () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toBe("1h ago");
    expect(formatRelative(NOW - 23 * 60 * 60_000, NOW)).toBe("23h ago");
  });

  it("renders days past 24h", () => {
    expect(formatRelative(NOW - 24 * 60 * 60_000, NOW)).toBe("1d ago");
    expect(formatRelative(NOW - 7 * 24 * 60 * 60_000, NOW)).toBe("7d ago");
  });
});

describe("formatRelative (future)", () => {
  it('returns "just now" for a target inside the 5s window in either direction', () => {
    expect(formatRelative(NOW + 4_999, NOW)).toBe("just now");
  });

  it("prefixes future deltas with 'in '", () => {
    expect(formatRelative(NOW + 10_000, NOW)).toBe("in 10s");
    expect(formatRelative(NOW + 60_000, NOW)).toBe("in 1m");
    expect(formatRelative(NOW + 2 * 60 * 60_000, NOW)).toBe("in 2h");
    expect(formatRelative(NOW + 6 * 24 * 60 * 60_000, NOW)).toBe("in 6d");
  });
});
