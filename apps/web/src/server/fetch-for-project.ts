import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EgressBlockedError, type ProjectConfig, ProjectConfigSchema } from "@ironlore/core";
import { load } from "js-yaml";

/**
 * Cached project configs keyed by projectDir.
 * In a single-process server this avoids re-reading YAML on every request.
 * The cache is never invalidated — restart the server to pick up config changes.
 */
const configCache = new Map<string, ProjectConfig>();

function loadProjectConfig(projectDir: string): ProjectConfig {
  const cached = configCache.get(projectDir);
  if (cached) return cached;

  const raw = readFileSync(join(projectDir, "project.yaml"), "utf-8");
  const parsed = load(raw);
  const config = ProjectConfigSchema.parse(parsed);
  configCache.set(projectDir, config);
  return config;
}

/**
 * Single choke-point for all outbound HTTP from Ironlore.
 *
 * Every network call — provider chat requests, image fetches, MCP servers,
 * agent shell.exec, update checks — must go through this function.
 *
 * A lint rule (`noRestrictedImports` in biome.json) bans direct `fetch`,
 * `axios`, and `node:https` imports outside this module.
 */
export async function fetchForProject(
  projectDir: string,
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const config = loadProjectConfig(projectDir);
  const parsed = typeof url === "string" ? new URL(url) : url;
  const policy = config.egress?.policy ?? "allowlist";

  if (!isAllowed(parsed.hostname, policy, config.egress?.allowlist)) {
    throw new EgressBlockedError(config.name, parsed.hostname, policy);
  }

  return fetch(parsed, init);
}

function isAllowed(
  hostname: string,
  policy: string,
  allowlist: string[] | undefined,
): boolean {
  switch (policy) {
    case "open":
      return true;
    case "blocked":
      return false;
    case "allowlist": {
      if (!allowlist || allowlist.length === 0) return false;
      return allowlist.some((entry) => {
        // Strip protocol if present (e.g. "https://api.anthropic.com" → "api.anthropic.com")
        const host = entry.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        return hostname === host;
      });
    }
    default:
      // Unknown policy — deny by default
      return false;
  }
}
