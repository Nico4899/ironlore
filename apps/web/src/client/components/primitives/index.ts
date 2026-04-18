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

export type { AgentPulseProps } from "./AgentPulse.js";
export { AgentPulse } from "./AgentPulse.js";
export type { BlockrefProps } from "./Blockref.js";
export { Blockref } from "./Blockref.js";
export type { DisplayNumProps } from "./DisplayNum.js";
export { DisplayNum } from "./DisplayNum.js";
export type { KeyProps } from "./Key.js";
export { Key } from "./Key.js";
export type { MetaProps } from "./Meta.js";
export { Meta } from "./Meta.js";
export type { ProvenanceStripProps, TrustState } from "./ProvenanceStrip.js";
export { ProvenanceStrip } from "./ProvenanceStrip.js";
export type { ReuleauxProps } from "./Reuleaux.js";
export { Reuleaux } from "./Reuleaux.js";
export type { SectionLabelProps } from "./SectionLabel.js";
export { SectionLabel } from "./SectionLabel.js";
export type { PipState, StatusPipProps } from "./StatusPip.js";
export { StatusPip } from "./StatusPip.js";
export type { VennProps } from "./Venn.js";
export { Venn } from "./Venn.js";
