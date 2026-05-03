interface BackupOptions {
  project: string;
  output?: string;
  /** Alias for --output. Resolved into `output` below. */
  out?: string;
}

// TODO(phase-5): implement. Archive projects/<id>/data/ only.
// Exclude install-root files (see BACKUP_EXCLUDED_FILES in
// @ironlore/core) and every project's .ironlore/ dir — credentials and
// derived state never ship in a portable archive. See docs/01-content-model.md.
export function backup(options: BackupOptions): void {
  // Accept both --output (canonical) and --out (alias). When both are
  //  passed, the more-specific canonical wins so a script that meant
  //  to override the default isn't silently shadowed.
  const dest =
    options.output ?? options.out ?? `ironlore-backup-${options.project}-${Date.now()}.tar.gz`;
  console.log(`Backing up project "${options.project}" to ${dest}...`);
  console.log("(Phase 0 stub — backup implementation ships in Phase 1)");
}
