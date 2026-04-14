interface BackupOptions {
  project: string;
  output?: string;
}

// TODO(phase-5): implement. Archive projects/<id>/data/ only.
// Exclude install-root files (see BACKUP_EXCLUDED_FILES in
// @ironlore/core) and every project's .ironlore/ dir — credentials and
// derived state never ship in a portable archive. See docs/01-content-model.md.
export function backup(options: BackupOptions): void {
  const dest = options.output ?? `ironlore-backup-${options.project}-${Date.now()}.tar.gz`;
  console.log(`Backing up project "${options.project}" to ${dest}...`);
  console.log("(Phase 0 stub — backup implementation ships in Phase 1)");
}
