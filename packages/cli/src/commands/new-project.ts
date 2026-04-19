import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Preset = "main" | "research" | "sandbox";

interface NewProjectOptions {
  name?: string;
  preset: Preset;
}

const VALID_PRESETS: Preset[] = ["main", "research", "sandbox"];

/**
 * `ironlore new-project <id>` — scaffold a new project directory.
 *
 * Per docs/08-projects-and-isolation.md §The project primitive, a
 * project is:
 *  · `projects/<id>/data/`            — content
 *  · `projects/<id>/.ironlore/`       — derived state (locks, wal, index)
 *  · `projects/<id>/project.yaml`     — metadata (preset + egress policy)
 *
 * The CLI only creates the layout on disk. Registration in
 * `projects.sqlite` happens at server boot — the registry's
 * `ensureProject(id, name, preset)` call idempotently inserts the row
 * when the server picks up the new directory. A server restart after
 * `new-project` is required for the in-flight process to mount routes
 * under `/api/projects/<id>/…`; an in-flight hot reload is a post-1.0
 * consideration, see docs/06-implementation-roadmap.md §Phase 9.
 *
 * This command is idempotent for the project.yaml write — if the
 * directory already exists and was created by this tool, rerunning
 * with a different preset refuses. Users who really want to overwrite
 * can delete and re-run.
 */
export function newProject(idArg: string, options: NewProjectOptions): void {
  const id = String(idArg ?? "").trim();
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    console.error(
      `Project id must match /^[a-z0-9][a-z0-9_-]*$/i — got ${JSON.stringify(id)}.`,
    );
    process.exit(2);
  }

  if (!VALID_PRESETS.includes(options.preset)) {
    console.error(
      `Invalid preset '${options.preset}' — must be one of ${VALID_PRESETS.join(", ")}.`,
    );
    process.exit(2);
  }

  const installRoot = process.cwd();
  const projectDir = join(installRoot, "projects", id);
  const yamlPath = join(projectDir, "project.yaml");

  if (existsSync(projectDir)) {
    console.error(`Project directory already exists at ${projectDir}. Nothing changed.`);
    process.exit(1);
  }

  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore", "locks"), { recursive: true });
  mkdirSync(join(projectDir, ".ironlore", "wal"), { recursive: true });

  const name = options.name?.trim() || id;
  const yaml = buildProjectYaml({ id, name, preset: options.preset });
  writeFileSync(yamlPath, yaml, { mode: 0o644 });

  console.log(`Created project '${id}' (${options.preset}) at ${projectDir}`);
  console.log("Restart the Ironlore server to mount /api/projects/" + id + "/…");
}

/**
 * Build the initial `project.yaml` content for a preset. The egress
 * defaults come from docs/08-projects-and-isolation.md §The project
 * primitive: main → allowlist (common provider hosts), research →
 * open, sandbox → blocked.
 */
export function buildProjectYaml(params: { id: string; name: string; preset: Preset }): string {
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
  return [
    ...common,
    "egress:",
    "  policy: blocked",
    "",
  ].join("\n");
}

function yamlString(s: string): string {
  // Very small quoter — YAML strings that don't need quoting pass
  //  through unchanged, everything else gets double-quotes with
  //  internal quotes escaped. We never emit multi-line names.
  if (/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
