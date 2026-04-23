/**
 * Minimal standard-cron parser — 5 fields, matching what personas
 * declare via `heartbeat: "0 6 * * 0"` in their frontmatter.
 *
 * Supports: literals (`5`), wildcards (`*`), inclusive ranges (`1-5`),
 * lists (`1,3,5`), and steps (`* / 10`, `0-12/2`). Day-of-month and
 * day-of-week are AND-ed — `0 0 1 * 1` fires on the 1st AND on Mondays
 * only when those coincide, matching Vixie cron semantics. Day-of-week
 * `0` and `7` both map to Sunday.
 *
 * Intentionally not a full spec: no predefined @daily / @hourly
 * macros, no seconds field, no command part. A future migration to a
 * real cron library is straightforward — callers only use
 * `parseCron` + `matches` + `shouldFire`.
 *
 * No external dependency. The install ships with Node's built-in
 * `Date`; a library just to interpret five whitespace-separated fields
 * would be overkill.
 */

export interface CronFields {
  /** Allowed minutes (0–59). */
  minute: Set<number>;
  /** Allowed hours (0–23). */
  hour: Set<number>;
  /** Allowed days of month (1–31). */
  dayOfMonth: Set<number>;
  /** Allowed months (1–12). */
  month: Set<number>;
  /** Allowed days of week (0–6, 0 = Sunday). */
  dayOfWeek: Set<number>;
  /** Whether the dayOfMonth field was literal `*` (affects AND vs OR semantics). */
  dayOfMonthIsWildcard: boolean;
  /** Whether the dayOfWeek field was literal `*`. */
  dayOfWeekIsWildcard: boolean;
}

/**
 * Parse a 5-field cron string into a `CronFields` struct. Throws on
 * malformed input; callers typically swallow the throw and skip the
 * agent so a typo in one persona cannot take down the scheduler.
 */
export function parseCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}: ${expr}`);
  }
  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  return {
    minute: expand(minuteField, 0, 59),
    hour: expand(hourField, 0, 23),
    dayOfMonth: expand(domField, 1, 31),
    month: expand(monthField, 1, 12),
    // Normalize DOW: accept both `0` and `7` for Sunday.
    dayOfWeek: normalizeDow(expand(dowField, 0, 7)),
    dayOfMonthIsWildcard: domField === "*",
    dayOfWeekIsWildcard: dowField === "*",
  };
}

/**
 * True if the given date matches the cron expression. Seconds are
 * ignored — callers that want minute-granular fire detection should
 * step the date minute-by-minute (see `shouldFire`).
 */
export function matches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false;
  if (!fields.hour.has(date.getHours())) return false;
  if (!fields.month.has(date.getMonth() + 1)) return false;

  const domMatch = fields.dayOfMonth.has(date.getDate());
  const dowMatch = fields.dayOfWeek.has(date.getDay());

  // Vixie-cron semantics: when either DOM or DOW is explicitly set,
  // the fields are OR-ed. When both are `*`, both trivially match
  // (equivalent to AND).
  if (fields.dayOfMonthIsWildcard && fields.dayOfWeekIsWildcard) return true;
  if (fields.dayOfMonthIsWildcard) return dowMatch;
  if (fields.dayOfWeekIsWildcard) return domMatch;
  return domMatch || dowMatch;
}

/**
 * True if the cron should fire at or before `now`, given that it last
 * fired at `lastFiredAt` (null = never). Walks minute-by-minute from
 * the minute after `lastFiredAt` (or from `now - 1 day` if never) up
 * to `now`, returning true on the first matching minute.
 *
 * Bounded to ~43k iterations (one month) to prevent unbounded scans
 * for a monthly cron whose last fire was years ago. That's fine for
 * hot paths — 43k `Date.getMinutes()` calls complete in <5 ms.
 */
export function shouldFire(fields: CronFields, now: Date, lastFiredAt: number | null): boolean {
  const maxLookback = 31 * 24 * 60; // 31 days in minutes.
  const start =
    lastFiredAt !== null
      ? new Date(lastFiredAt + 60_000)
      : new Date(now.getTime() - maxLookback * 60_000);

  // Floor to minute boundary to avoid sub-minute drift.
  const cursor = new Date(start);
  cursor.setSeconds(0, 0);

  const end = new Date(now);
  end.setSeconds(0, 0);

  let iterations = 0;
  while (cursor.getTime() <= end.getTime() && iterations < maxLookback + 1) {
    if (matches(fields, cursor)) return true;
    cursor.setTime(cursor.getTime() + 60_000);
    iterations++;
  }
  return false;
}

/**
 * Return the timestamp of the next minute at or after `from` that
 * matches the cron, or `null` if no match in the next 31 days. Used by
 * the observability API to surface "next fire" on the Agent-detail
 * §04 Config row.
 *
 * The 31-day cap matches `shouldFire`'s lookback: no cron with a
 * sensible cadence will skip a month without firing, so returning null
 * for the "never fires in the next month" case is the honest answer.
 * Floors to the minute boundary — seconds are ignored, matching
 * standard cron.
 */
export function nextFireAt(fields: CronFields, from: Date): Date | null {
  const maxLookahead = 31 * 24 * 60;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  // If `from` itself has a sub-minute offset, it's already past that
  // minute's firing moment — advance one minute so the result is
  // strictly >= `from` without re-firing the current minute.
  if (cursor.getTime() < from.getTime()) cursor.setTime(cursor.getTime() + 60_000);

  for (let i = 0; i <= maxLookahead; i++) {
    if (matches(fields, cursor)) return new Date(cursor);
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

/**
 * Expand a single cron field — wildcard `*`, literal `7`, range `0-8`,
 * list `1,3,5`, step-on-wildcard `<star>/5`, or step-on-range `0-12/2` —
 * to the set of numeric values within [min, max]. Throws on malformed
 * input. (The `<star>/N` spelling keeps JSDoc from treating the slash
 * as a block-comment terminator.)
 */
function expand(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.includes("/") ? part.split("/") : [part, "1"];
    if (range === undefined) throw new Error(`empty cron range in '${field}'`);
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step '${stepStr}' in '${field}'`);
    }

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [loStr, hiStr] = range.split("-");
      lo = Number(loStr);
      hi = Number(hiStr);
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
      throw new Error(`invalid cron range '${range}' in '${field}'`);
    }
    if (lo < min || hi > max) {
      throw new Error(`cron range ${lo}-${hi} out of bounds [${min},${max}] in '${field}'`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function normalizeDow(set: Set<number>): Set<number> {
  if (set.has(7)) {
    set.delete(7);
    set.add(0);
  }
  return set;
}
