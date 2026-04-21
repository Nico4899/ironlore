import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectPreset } from "./types.js";

/**
 * Node-only helpers for scaffolding a new Ironlore project on disk.
 *
 * Shared by `ironlore new-project` (CLI) and `POST /api/projects`
 * (server) so both write the same layout + project.yaml. See
 * docs/08-projects-and-isolation.md §The project primitive for the
 * canonical shape.
 *
 * Not re-exported from `packages/core/src/index.ts` because it uses
 * `node:fs` + `node:path`. Server/CLI callers import it via
 * `packages/core/src/server.ts` instead, following the same pattern
 * as `resolve-safe.ts`.
 */

export const VALID_PRESETS: readonly ProjectPreset[] = ["main", "research", "sandbox"] as const;

/**
 * Project ID regex. Matches docs/08-projects-and-isolation.md
 * §Project id rules: leading alphanumeric, then alphanumeric /
 * underscore / dash. Case-insensitive but we down-case before
 * matching so `main` and `Main` collide on disk.
 */
export const PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export const MAX_PROJECT_ID_LENGTH = 40;

export class InvalidProjectIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectIdError";
  }
}

export class InvalidPresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPresetError";
  }
}

export class ProjectAlreadyExistsError extends Error {
  constructor(public readonly projectDir: string) {
    super(`Project directory already exists at ${projectDir}.`);
    this.name = "ProjectAlreadyExistsError";
  }
}

/**
 * Validate a project ID against the canonical regex + length cap.
 * Lowercases the input before matching so the resulting ID is
 * always canonical. Returns the normalised ID on success; throws
 * `InvalidProjectIdError` otherwise.
 */
export function validateProjectId(raw: string): string {
  const id = String(raw ?? "").trim().toLowerCase();
  if (!id) throw new InvalidProjectIdError("Project id is required.");
  if (id.length > MAX_PROJECT_ID_LENGTH) {
    throw new InvalidProjectIdError(
      `Project id must be ${MAX_PROJECT_ID_LENGTH} characters or fewer.`,
    );
  }
  if (!PROJECT_ID_REGEX.test(id)) {
    throw new InvalidProjectIdError(
      "Project id must start with a letter or digit and contain only a-z, 0-9, _, -.",
    );
  }
  return id;
}

/**
 * Ensure the preset is one of the documented set. Throws
 * `InvalidPresetError` otherwise. Returns the preset unchanged on
 * success so the caller gets a narrowed type.
 */
export function validatePreset(raw: string): ProjectPreset {
  if ((VALID_PRESETS as readonly string[]).includes(raw)) {
    return raw as ProjectPreset;
  }
  throw new InvalidPresetError(
    `Preset must be one of ${VALID_PRESETS.join(", ")} — got ${JSON.stringify(raw)}.`,
  );
}

/**
 * Scaffold the project directory tree + project.yaml. Does NOT
 * touch the SQLite registry; callers (server) are responsible for
 * calling `registry.ensureProject(id, name, preset)` afterwards.
 *
 * Throws `ProjectAlreadyExistsError` if the directory is occupied.
 * Returns the absolute path of the created project directory.
 */
export function scaffoldProjectOnDisk(params: {
  installRoot: string;
  id: string;
  name?: string | null;
  preset: ProjectPreset;
}): { projectDir: string } {
  const { installRoot, id, preset } = params;
  const projectDir = join(installRoot, "projects", id);

  if (existsSync(projectDir)) {
    throw new ProjectAlreadyExistsError(projectDir);
  }

  // Layout matches docs/08-projects-and-isolation.md:45–57.
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore", "locks"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore", "wal"), { recursive: true });

  const name = (params.name ?? "").trim() || id;
  const yaml = buildProjectYaml({ id, name, preset });
  writeFileSync(join(projectDir, "project.yaml"), yaml, { mode: 0o644 });

  return { projectDir };
}

/**
 * Build the initial `project.yaml` content for a preset. The egress
 * defaults come from docs/08-projects-and-isolation.md §The project
 * primitive: main → allowlist (common provider hosts), research →
 * open, sandbox → blocked.
 */
export function buildProjectYaml(params: {
  id: string;
  name: string;
  preset: ProjectPreset;
}): string {
  const { id, name, preset } = params;
  const created = new Date().toISOString();
  const common = [
    "# Ironlore project config",
    "# See docs/08-projects-and-isolation.md",
    "",
    "schema: 1",
    `id: ${id}`,
    `name: ${yamlString(name)}`,
    `preset: ${preset}`,
    `created: ${created}`,
    "",
  ];

  if (preset === "main") {
    return [
      ...common,
      "egress:",
      "  policy: allowlist",
      "  allowlist:",
      "    - api.anthropic.com",
      "    - api.openai.com",
      "",
    ].join("\n");
  }
  if (preset === "research") {
    return [
      ...common,
      "egress:",
      "  policy: open",
      "",
      "# Research projects absorb untrusted content — never auto-promote",
      "# to a main project. See §Promotion: the only crossing point.",
      "accept_promotions_from: []",
      "",
    ].join("\n");
  }
  // sandbox
  return [...common, "egress:", "  policy: blocked", ""].join("\n");
}

function yamlString(s: string): string {
  // Very small quoter — YAML strings that don't need quoting pass
  //  through unchanged, everything else gets double-quotes with
  //  internal quotes escaped. We never emit multi-line names.
  if (/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
