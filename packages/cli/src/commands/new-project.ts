import {
  InvalidPresetError,
  InvalidProjectIdError,
  ProjectAlreadyExistsError,
  type ProjectPreset,
  scaffoldProjectOnDisk,
  validatePreset,
  validateProjectId,
} from "@ironlore/core/server";

interface NewProjectOptions {
  name?: string;
  preset: ProjectPreset | string;
}

/**
 * `ironlore new-project <id>` — scaffold a new project directory.
 *
 * Thin CLI wrapper around `scaffoldProjectOnDisk` from
 * `@ironlore/core/server`. The core helper is shared with the web
 * `POST /api/projects` endpoint so both paths produce identical
 * layouts + project.yaml.
 *
 * Registration in `projects.sqlite` happens at server boot — the
 * registry's `ensureProject(id, name, preset)` call idempotently
 * inserts the row when the server picks up the new directory. A
 * server restart after `new-project` is required for the in-flight
 * process to mount routes under `/api/projects/<id>/…`; see
 * docs/06-implementation-roadmap.md §Phase 9.
 */
export function newProject(idArg: string, options: NewProjectOptions): void {
  let id: string;
  try {
    id = validateProjectId(idArg);
  } catch (err) {
    if (err instanceof InvalidProjectIdError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  let preset: ProjectPreset;
  try {
    preset = validatePreset(String(options.preset));
  } catch (err) {
    if (err instanceof InvalidPresetError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  try {
    const { projectDir } = scaffoldProjectOnDisk({
      installRoot: process.cwd(),
      id,
      name: options.name,
      preset,
    });
    console.log(`Created project '${id}' (${preset}) at ${projectDir}`);
    console.log(`Restart the Ironlore server to mount /api/projects/${id}/…`);
  } catch (err) {
    if (err instanceof ProjectAlreadyExistsError) {
      console.error(`${err.message} Nothing changed.`);
      process.exit(1);
    }
    throw err;
  }
}
