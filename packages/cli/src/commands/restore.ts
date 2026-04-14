interface RestoreOptions {
  project: string;
}

// TODO(phase-5): implement. Restore extracts into projects/<id>/data/ only.
// Admin password is regenerated (new .ironlore-install.json); provider API
// keys must be re-entered per project. See docs/01-content-model.md.
export function restore(archive: string, options: RestoreOptions): void {
  console.log(`Restoring project "${options.project}" from ${archive}...`);
  console.log("(Phase 0 stub — restore implementation ships in Phase 1)");
}
