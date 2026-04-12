import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSafe } from "@ironlore/core";

/**
 * Allowlisted environment variables passed to subprocesses.
 * Everything else — ANTHROPIC_API_KEY, AWS_*, GITHUB_TOKEN, database URLs,
 * ambient secrets — is stripped.
 */
const ALLOWED_ENV_KEYS = new Set(["PATH", "HOME", "LANG", "TERM"]);

/**
 * Build a sanitized PATH that enriches common tool locations.
 * Ensures `git`, `claude`, `python`, etc. are findable.
 */
function buildSafePath(): string {
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(home, ".nvm", "versions", "node"),
    "/usr/bin",
    "/bin",
  ];

  // On macOS, nvm installs to a nested directory
  const nvmDir = join(home, ".nvm", "versions", "node");
  if (existsSync(nvmDir)) {
    // Find latest node version
    try {
      const { readdirSync } = require("node:fs");
      const versions = readdirSync(nvmDir) as string[];
      if (versions.length > 0) {
        const latest = versions[versions.length - 1];
        if (latest) {
          candidates.unshift(join(nvmDir, latest, "bin"));
        }
      }
    } catch {
      // nvm dir not readable, skip
    }
  }

  const existing = candidates.filter((p) => existsSync(p));

  // Append parent's PATH at the end (only known-safe portions filtered above
  // come first, but we include the rest for tool discovery)
  const parentPath = process.env.PATH ?? "";
  return [...existing, parentPath].join(":");
}

/**
 * Spawn a subprocess with a sanitized environment.
 *
 * - Only allowlisted env vars are passed through
 * - PATH is enriched with common tool locations
 * - Project-specific env vars (IRONLORE_PROJECT_ID, provider keys) are added
 * - cwd is validated through resolveSafe
 *
 * @param command - The command to run
 * @param args - Command arguments
 * @param options - Additional options
 * @param options.cwd - Working directory (validated through resolveSafe)
 * @param options.dataRoot - Project data root for cwd validation
 * @param options.projectId - Project ID to expose as IRONLORE_PROJECT_ID
 * @param options.extraEnv - Additional env vars (e.g. provider API keys)
 */
export function spawnSafe(
  command: string,
  args: string[],
  options: {
    cwd: string;
    dataRoot: string;
    projectId: string;
    extraEnv?: Record<string, string>;
    spawnOptions?: Omit<SpawnOptions, "cwd" | "env">;
  },
): ChildProcess {
  // Validate cwd is within data root
  resolveSafe(options.dataRoot, options.cwd);

  // Build sanitized environment
  const env: Record<string, string> = {};

  for (const key of ALLOWED_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // Override PATH with enriched version
  env.PATH = buildSafePath();

  // Add ironlore-specific env
  env.IRONLORE_PROJECT_ID = options.projectId;

  // Add any project-specific provider keys
  if (options.extraEnv) {
    for (const [key, val] of Object.entries(options.extraEnv)) {
      env[key] = val;
    }
  }

  return spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: "pipe",
    ...options.spawnOptions,
  });
}
