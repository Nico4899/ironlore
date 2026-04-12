interface ReindexOptions {
  all?: boolean;
  project: string;
}

export function reindex(options: ReindexOptions): void {
  const target = options.all ? "all projects" : `project "${options.project}"`;
  console.log(`Reindexing ${target}...`);
  console.log("(Phase 0 stub — reindex implementation ships in Phase 1)");
}
