/**
 * Four motion durations, mirrored from `globals.css :root --motion-*`.
 *
 * CSS land references `var(--motion-*)`; JS land (`setTimeout`,
 * requestAnimationFrame helpers) references these constants. Keeping
 * both views tight against one source of truth means a spec change
 * lands in two spots, not fifty.
 *
 * Per docs/09-ui-and-brand.md §Motion language — these are the only
 * valid durations in the product.
 */
export const MOTION = {
  /** 80ms — hover/focus feedback. */
  snap: 80,
  /** 180ms — panel open, tab switch, drawer. */
  transit: 180,
  /** 1500ms — attention flash (provenance target highlight). */
  flash: 1500,
  /** 3200ms — ambient agent-pulse sweep. */
  pulse: 3200,
} as const;

export type MotionToken = keyof typeof MOTION;
