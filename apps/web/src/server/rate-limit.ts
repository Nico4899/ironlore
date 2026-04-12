import { AGENT_RATE_LIMIT, AUTH_RATE_LIMIT } from "@ironlore/core";
import type { Context, Next } from "hono";

// ---------------------------------------------------------------------------
// Token bucket rate limiter
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  lastRefill: number;
}

class TokenBucket {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxTokens: number,
    private readonly refillRatePerS: number,
  ) {}

  /**
   * Try to consume one token for the given key.
   * Returns true if allowed, false if rate-limited.
   */
  consume(key: string): boolean {
    const now = Date.now() / 1000;
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.maxTokens - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return true;
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRatePerS);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /** Prune old entries to prevent memory leaks. */
  prune(): void {
    const now = Date.now() / 1000;
    for (const [key, bucket] of this.buckets) {
      // If the bucket has been full for over 5 minutes, remove it
      if (now - bucket.lastRefill > 300 && bucket.tokens >= this.maxTokens) {
        this.buckets.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Auth rate limiter — 5 attempts/min per IP+username
// ---------------------------------------------------------------------------

const authBucket = new TokenBucket(AUTH_RATE_LIMIT, AUTH_RATE_LIMIT / 60);

/**
 * Rate-limit middleware for auth endpoints.
 * Key: IP + username (from JSON body, if parseable).
 */
export function authRateLimiter() {
  return async (c: Context, next: Next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";
    // For auth routes, we key by IP alone (username may not be known yet for GET routes)
    const key = `auth:${ip}`;

    if (!authBucket.consume(key)) {
      return c.json({ error: "Too many login attempts. Please wait before trying again." }, 429);
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// Agent tool-call rate limiter — 60 calls/min per project+agent
// ---------------------------------------------------------------------------

const agentBucket = new TokenBucket(AGENT_RATE_LIMIT, AGENT_RATE_LIMIT / 60);

/**
 * Rate-limit middleware for agent tool calls.
 * Key: projectId + agentSlug (from request context or headers).
 */
export function agentRateLimiter() {
  return async (c: Context, next: Next) => {
    const projectId = c.get("currentProjectId") ?? "main";
    const agentSlug = c.req.header("x-ironlore-agent") ?? "unknown";
    const key = `agent:${projectId}:${agentSlug}`;

    if (!agentBucket.consume(key)) {
      return c.json({ error: "Agent rate limit exceeded. Please wait before retrying." }, 429);
    }

    await next();
  };
}

// Prune stale buckets every 5 minutes
setInterval(
  () => {
    authBucket.prune();
    agentBucket.prune();
  },
  5 * 60 * 1000,
).unref();
