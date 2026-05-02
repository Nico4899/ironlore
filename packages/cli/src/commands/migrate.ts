/**
 * Schema migrations.
 *
 * Currently install-global (no per-project state). Accepts
 * `--project <id>` for symmetry with sibling commands so muscle
 * memory from `lint --project main`, `reindex --project main`, etc.
 * doesn't surface an "unknown option" error. The flag is recorded
 * but doesn't change behaviour today; once Phase-1 ships per-project
 * migrations the flag will scope the run.
 */
export function migrate(opts: { project?: string } = {}): void {
  console.log("Running pending migrations...");
  if (opts.project) {
    console.log(
      `(Scope: install-global — '--project ${opts.project}' is recorded but Phase-0 migrations are not per-project.)`,
    );
  }
  console.log("No pending migrations.");
  console.log("(Phase 0 stub — migrations implementation ships in Phase 1)");
}
