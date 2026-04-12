import type { CorsOptions } from "hono/cors";

/**
 * Build CORS configuration from IRONLORE_ALLOWED_ORIGINS.
 *
 * - Unset: same-origin only (no CORS headers needed → return null)
 * - Comma-separated list: exact-match origins
 * - "*" is rejected at startup — never allow wildcard
 */
export function createCorsConfig(): CorsOptions | null {
  const raw = process.env.IRONLORE_ALLOWED_ORIGINS;

  if (!raw) {
    return null; // same-origin, no CORS headers
  }

  if (raw.trim() === "*") {
    console.error(
      "Error: IRONLORE_ALLOWED_ORIGINS='*' is not allowed.\n" +
        "Specify exact origins (comma-separated) or omit for same-origin only.",
    );
    process.exit(1);
  }

  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    origin: origins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization", "If-Match", "X-Ironlore-Worker-Token"],
    exposeHeaders: ["ETag"],
    credentials: true,
  };
}
