import { createHash } from "node:crypto";

/**
 * Compute a content-addressed ETag from file content.
 *
 * Returns a strong ETag string: `"sha256-<hex>"`.
 * Every GET returns this; every PUT must cite it via `If-Match`.
 */
export function computeEtag(content: string | Buffer): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `"sha256-${hash}"`;
}

/**
 * Strip surrounding quotes from an ETag header value for comparison.
 */
export function parseEtag(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  return raw;
}
