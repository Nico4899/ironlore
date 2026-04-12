import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IPC_TOKEN_FILE } from "@ironlore/core";
import type { Context, Next } from "hono";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/**
 * Middleware that guards `/api/internal/*` routes.
 *
 * Requirements:
 * 1. Request must originate from a loopback address
 * 2. `X-Ironlore-Worker-Token` header must match the on-disk ipc.token
 *    (compared with timingSafeEqual to prevent timing attacks)
 */
export function createIpcAuthMiddleware(installRoot: string) {
  return async (c: Context, next: Next) => {
    // Check loopback origin
    const remoteAddr =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "127.0.0.1";

    if (!LOOPBACK.has(remoteAddr)) {
      console.warn(`IPC auth rejected: non-loopback source ${remoteAddr}`);
      return c.json({ error: "Forbidden: loopback only" }, 403);
    }

    // Validate token
    const provided = c.req.header("X-Ironlore-Worker-Token");
    if (!provided) {
      return c.json({ error: "Missing X-Ironlore-Worker-Token header" }, 401);
    }

    let expected: string;
    try {
      expected = readFileSync(join(installRoot, IPC_TOKEN_FILE), "utf-8").trim();
    } catch {
      console.error("IPC auth: cannot read ipc.token");
      return c.json({ error: "Internal server error" }, 500);
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      console.warn(`IPC auth rejected: token mismatch from ${remoteAddr}`);
      return c.json({ error: "Invalid token" }, 401);
    }

    await next();
  };
}
