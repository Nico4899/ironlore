/**
 * Compact relative-time formatter used across the Agent Detail
 * "last fire" / "next fire" rows and the Inbox entry-header chip.
 *
 * Past targets render as `"Ns ago"` / `"Nm ago"` / `"Nh ago"` /
 * `"Nd ago"`. Future targets render as `"in Ns"` / `"in Nm"` / etc.
 * Within a 5-second window of `now` we emit `"just now"`, which reads
 * more naturally than `"0s ago"` and avoids 1-second flicker.
 *
 * Unlike `Intl.RelativeTimeFormat`, this formatter is monospaced by
 * construction (one or two digits + single letter) and deliberately
 * English-only — every other time display in the product (mono
 * timestamps, keyboard chips, locators) is also English-only.
 */
export function formatRelative(targetMs: number, now: number): string {
  // Floor the absolute delta so `Math.floor(-4.999) === -5` can't push
  // a 4.9-second-old target past the 5s `"just now"` window.
  const deltaMs = targetMs - now;
  const absSec = Math.floor(Math.abs(deltaMs) / 1000);
  if (absSec < 5) return "just now";

  const [value, unit] = pickUnit(absSec);
  return deltaMs < 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
}

function pickUnit(absSec: number): [number, "s" | "m" | "h" | "d"] {
  if (absSec < 60) return [absSec, "s"];
  const min = Math.floor(absSec / 60);
  if (min < 60) return [min, "m"];
  const hr = Math.floor(min / 60);
  if (hr < 24) return [hr, "h"];
  return [Math.floor(hr / 24), "d"];
}
