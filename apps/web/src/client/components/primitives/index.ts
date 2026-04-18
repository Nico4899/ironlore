/**
 * Ironlore primitive components (rev 3 design system).
 *
 * These are the load-bearing visual primitives from
 * docs/09-ui-and-brand.md. Every one of them replaces a less
 * opinionated equivalent (Lucide Dot, plain anchor, ad-hoc gradient
 * div) so the product visually converges on a small, recognizable
 * vocabulary.
 *
 * Import from `../primitives` — the index re-export is the public
 * surface; individual files may be refactored without touching
 * callers.
 */

export { Reuleaux } from "./Reuleaux.js";
export type { ReuleauxProps } from "./Reuleaux.js";
export { StatusPip } from "./StatusPip.js";
export type { PipState, StatusPipProps } from "./StatusPip.js";
