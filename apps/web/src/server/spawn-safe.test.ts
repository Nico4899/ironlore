import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSafeEnv } from "./spawn-safe.js";

/**
 * `buildSafeEnv` is the single source of truth for subprocess env
 * scrubbing. Both `spawnSafe` (child_process) and `TerminalManager`
 * (node-pty) go through it. These tests lock in the allow-list so a
 * regression here can never silently expose provider keys or AWS
 * credentials to a user-driven shell.
 */
describe("buildSafeEnv", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keysToSave = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "DATABASE_URL",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "IRONLORE_SECRET",
  ];

  beforeEach(() => {
    for (const k of keysToSave) savedEnv[k] = process.env[k];
    // Prime process.env with a known-dangerous set.
    process.env.ANTHROPIC_API_KEY = "sk-leak-test-anthropic";
    process.env.OPENAI_API_KEY = "sk-leak-test-openai";
    process.env.AWS_ACCESS_KEY_ID = "AKIA-leak";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-leak";
    process.env.GITHUB_TOKEN = "ghp_leak";
    process.env.DATABASE_URL = "postgres://leak@host/db";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/leak.json";
    process.env.IRONLORE_SECRET = "internal-leak";
  });

  afterEach(() => {
    for (const k of keysToSave) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("drops every provider / cloud / internal secret from the parent env", () => {
    const env = buildSafeEnv({ projectId: "main" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.IRONLORE_SECRET).toBeUndefined();
  });

  it("keeps only the whitelisted keys plus IRONLORE_PROJECT_ID", () => {
    const env = buildSafeEnv({ projectId: "main" });
    const allowed = new Set(["PATH", "HOME", "LANG", "TERM", "IRONLORE_PROJECT_ID"]);
    for (const key of Object.keys(env)) {
      expect(allowed.has(key), `buildSafeEnv leaked an unexpected key: ${key}`).toBe(true);
    }
  });

  it("passes IRONLORE_PROJECT_ID through from options", () => {
    const env = buildSafeEnv({ projectId: "research" });
    expect(env.IRONLORE_PROJECT_ID).toBe("research");
  });

  it("appends extraEnv entries (for per-project provider keys)", () => {
    const env = buildSafeEnv({
      projectId: "main",
      extraEnv: { ANTHROPIC_API_KEY: "project-scoped-key" },
    });
    expect(env.ANTHROPIC_API_KEY).toBe("project-scoped-key");
  });

  it("enriches PATH beyond the ambient value", () => {
    const env = buildSafeEnv({ projectId: "main" });
    const pathValue = env.PATH;
    expect(pathValue).toBeDefined();
    // The enriched PATH always contains at least one absolute path.
    expect((pathValue ?? "").split(":").some((seg) => seg.startsWith("/"))).toBe(true);
  });
});
