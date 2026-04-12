interface BackupOptions {
  project: string;
  output?: string;
}

export function backup(options: BackupOptions): void {
  const dest = options.output ?? `ironlore-backup-${options.project}-${Date.now()}.tar.gz`;
  console.log(`Backing up project "${options.project}" to ${dest}...`);
  console.log("(Phase 0 stub — backup implementation ships in Phase 1)");
}
