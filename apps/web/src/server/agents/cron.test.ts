import { describe, expect, it } from "vitest";
import { type CronFields, matches, nextFireAt, parseCron, shouldFire } from "./cron.js";

/**
 * Cron parser tests. Exercises every syntax the scheduler must
 * tolerate in user-authored persona frontmatter: wildcards, literals,
 * ranges, lists, steps, and the Vixie DOM/DOW OR semantics.
 */

function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  // mo is 1-based; Date wants 0-based.
  return new Date(y, mo - 1, d, h, mi);
}

describe("parseCron", () => {
  it("parses a bare literal (`0 6 * * 0` — Sunday 6am)", () => {
    const f = parseCron("0 6 * * 0");
    expect([...f.minute]).toEqual([0]);
    expect([...f.hour]).toEqual([6]);
    expect([...f.dayOfWeek]).toEqual([0]);
    expect(f.dayOfMonthIsWildcard).toBe(true);
    expect(f.dayOfWeekIsWildcard).toBe(false);
  });

  it("expands `*` to full range", () => {
    const f = parseCron("* * * * *");
    expect(f.minute.size).toBe(60);
    expect(f.hour.size).toBe(24);
    expect(f.dayOfMonth.size).toBe(31);
    expect(f.month.size).toBe(12);
    expect(f.dayOfWeek.size).toBe(7);
  });

  it("expands step on wildcard (`*/10`) to every Nth value", () => {
    const f = parseCron("*/10 * * * *");
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it("expands range with step (`0-20/5`)", () => {
    const f = parseCron("0-20/5 * * * *");
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 5, 10, 15, 20]);
  });

  it("expands lists (`1,5,15`)", () => {
    const f = parseCron("1,5,15 * * * *");
    expect([...f.minute].sort((a, b) => a - b)).toEqual([1, 5, 15]);
  });

  it("normalizes day-of-week 7 → 0 (both are Sunday)", () => {
    const f = parseCron("0 0 * * 7");
    expect([...f.dayOfWeek]).toEqual([0]);
  });

  it("accepts weekday ranges (`1-5` Mon–Fri)", () => {
    const f = parseCron("0 9 * * 1-5");
    expect([...f.dayOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects expressions with the wrong field count", () => {
    expect(() => parseCron("0 0 * *")).toThrow(/5 fields/);
    expect(() => parseCron("0 0 * * * *")).toThrow(/5 fields/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 0 * * *")).toThrow();
    expect(() => parseCron("0 24 * * *")).toThrow();
    expect(() => parseCron("0 0 32 * *")).toThrow();
    expect(() => parseCron("0 0 * 13 *")).toThrow();
  });

  it("rejects malformed ranges and steps", () => {
    expect(() => parseCron("0-abc 0 * * *")).toThrow();
    expect(() => parseCron("*/0 0 * * *")).toThrow();
    expect(() => parseCron("*/-1 0 * * *")).toThrow();
  });
});

describe("matches", () => {
  it("matches an exact minute/hour/weekday", () => {
    const f = parseCron("0 6 * * 0"); // Sunday 6:00
    // 2026-01-04 is a Sunday.
    expect(matches(f, at(2026, 1, 4, 6, 0))).toBe(true);
    expect(matches(f, at(2026, 1, 4, 6, 1))).toBe(false);
    expect(matches(f, at(2026, 1, 4, 7, 0))).toBe(false);
    expect(matches(f, at(2026, 1, 5, 6, 0))).toBe(false); // Monday
  });

  it("OR-s DOM and DOW when both are non-wildcard (Vixie semantics)", () => {
    // 1st of month OR Monday.
    const f: CronFields = parseCron("0 0 1 * 1");
    // 2026-01-01 is a Thursday, but it's the 1st → match.
    expect(matches(f, at(2026, 1, 1, 0, 0))).toBe(true);
    // 2026-01-05 is a Monday → match.
    expect(matches(f, at(2026, 1, 5, 0, 0))).toBe(true);
    // 2026-01-06 is a Tuesday, not the 1st → no match.
    expect(matches(f, at(2026, 1, 6, 0, 0))).toBe(false);
  });

  it("AND-s DOM and month when DOW is wildcard", () => {
    const f = parseCron("0 0 15 3 *"); // March 15
    expect(matches(f, at(2026, 3, 15, 0, 0))).toBe(true);
    expect(matches(f, at(2026, 3, 16, 0, 0))).toBe(false);
    expect(matches(f, at(2026, 4, 15, 0, 0))).toBe(false);
  });
});

describe("shouldFire", () => {
  it("fires when cron has matched since lastFiredAt", () => {
    const f = parseCron("0 6 * * 0"); // Sunday 6am
    const lastSun = at(2026, 1, 4, 6, 0).getTime(); // fired last Sunday
    const nextSun = at(2026, 1, 11, 6, 5); // now is 5 minutes after next Sunday fire
    expect(shouldFire(f, nextSun, lastSun)).toBe(true);
  });

  it("does not fire when no cron minute has matched since lastFiredAt", () => {
    const f = parseCron("0 6 * * 0"); // Sunday 6am
    const lastSun = at(2026, 1, 4, 6, 0).getTime();
    // A week minus one minute later — the exact minute has not come yet.
    const notYet = at(2026, 1, 11, 5, 59);
    expect(shouldFire(f, notYet, lastSun)).toBe(false);
  });

  it("does not double-fire within the same minute", () => {
    const f = parseCron("0 6 * * 0");
    const lastSun = at(2026, 1, 11, 6, 0).getTime();
    // Same minute as last fire.
    expect(shouldFire(f, at(2026, 1, 11, 6, 0), lastSun)).toBe(false);
  });

  it("first-run (lastFiredAt=null) fires if the last 31 days contain a match", () => {
    const f = parseCron("0 6 * * 0"); // weekly
    expect(shouldFire(f, at(2026, 1, 11, 6, 0), null)).toBe(true);
  });

  it("does not fire before lastFiredAt has even been reached", () => {
    const f = parseCron("*/5 * * * *");
    // "Now" before last fire is pathological but must not loop or crash.
    const lastAt = at(2026, 1, 4, 6, 0).getTime();
    expect(shouldFire(f, at(2026, 1, 4, 5, 59), lastAt)).toBe(false);
  });

  it("catches up on a single missed fire across a restart", () => {
    const f = parseCron("*/10 * * * *");
    // Fired at 12:00. Server came back online at 12:15. A tick at
    // 12:15 should see the 12:10 miss and fire once.
    const lastAt = at(2026, 1, 1, 12, 0).getTime();
    expect(shouldFire(f, at(2026, 1, 1, 12, 15), lastAt)).toBe(true);
  });
});

describe("nextFireAt", () => {
  it("returns the current minute when it already matches", () => {
    const f = parseCron("*/10 * * * *");
    // 12:00 is on a 10-minute boundary.
    const result = nextFireAt(f, at(2026, 1, 1, 12, 0));
    expect(result?.getTime()).toBe(at(2026, 1, 1, 12, 0).getTime());
  });

  it("advances to the next matching minute when the current one doesn't match", () => {
    const f = parseCron("*/10 * * * *");
    // 12:03 → next match is 12:10.
    const result = nextFireAt(f, at(2026, 1, 1, 12, 3));
    expect(result?.getTime()).toBe(at(2026, 1, 1, 12, 10).getTime());
  });

  it("finds the next Sunday 06:00 for a weekly gardener cron", () => {
    const f = parseCron("0 6 * * 0"); // Sunday 6am
    // Wednesday 2026-01-07 12:00 → next Sunday is 2026-01-11 06:00.
    const result = nextFireAt(f, at(2026, 1, 7, 12, 0));
    expect(result?.getFullYear()).toBe(2026);
    expect(result?.getMonth()).toBe(0); // January
    expect(result?.getDate()).toBe(11);
    expect(result?.getDay()).toBe(0); // Sunday
    expect(result?.getHours()).toBe(6);
    expect(result?.getMinutes()).toBe(0);
  });

  it("crosses month boundaries", () => {
    const f = parseCron("0 0 1 * *"); // first of every month at midnight
    // 2026-01-15 → next match is 2026-02-01 00:00.
    const result = nextFireAt(f, at(2026, 1, 15, 0, 0));
    expect(result?.getMonth()).toBe(1); // February
    expect(result?.getDate()).toBe(1);
  });

  it("advances past sub-minute offsets without re-firing the current minute", () => {
    const f = parseCron("*/10 * * * *");
    // 12:00:30 — the :00 slot has technically passed as a firing
    // moment, but the minute 12:00 itself still matches. We want
    // the next match strictly >= `from`, so :00:30 → 12:10.
    const from = new Date(2026, 0, 1, 12, 0, 30);
    const result = nextFireAt(f, from);
    expect(result?.getTime()).toBe(at(2026, 1, 1, 12, 10).getTime());
  });

  it("returns null when no match occurs within the 31-day lookahead", () => {
    // Feb-30 doesn't exist. A cron pinned to Feb-30 would never fire
    // except that Vixie DOM/DOW OR semantics and month rollover
    // make plain "Feb 30" unreachable in isolation. Easier pathological
    // case: Feb 29 + non-leap-year stretch. 2026 is non-leap, 2027 is
    // non-leap, 2028 IS leap — so from 2026-03-01 the next Feb 29 is
    // 2028-02-29, which is >31 days away.
    const f = parseCron("0 0 29 2 *"); // Feb 29 midnight
    const result = nextFireAt(f, at(2026, 3, 1, 0, 0));
    expect(result).toBeNull();
  });
});
