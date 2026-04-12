interface RestoreOptions {
  project: string;
}

export function restore(archive: string, options: RestoreOptions): void {
  console.log(`Restoring project "${options.project}" from ${archive}...`);
  console.log("(Phase 0 stub — restore implementation ships in Phase 1)");
}
