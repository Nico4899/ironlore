import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignBlockIds } from "@ironlore/core";

interface RepairOptions {
  project: string;
  dryRun?: boolean;
  /**
   * Walk every `.md` file under `projects/<id>/data/` and stamp
   * missing `<!-- #blk_… -->` IDs in-place via `assignBlockIds`.
   * Idempotent — files where every block is already stamped are
   * skipped, the on-disk byte content is untouched.
   *
   * The seeder pre-stamps fresh installs, so this flag is only
   * useful for vaults that were created before the seeder gained
   * that pass (or for vaults populated by hand / rsync). Combine
   * with `--dry-run` to preview which files would change.
   */
  addBlockIds?: boolean;
  /**
   * Override `process.cwd()` when resolving the project path. Used
   * by tests that run inside a tempdir without mutating the global
   * working directory.
   */
  cwd?: string;
}

export function repair(options: RepairOptions): void {
  if (options.addBlockIds) {
    runAddBlockIds(options);
    return;
  }

  const mode = options.dryRun ? "(dry run)" : "";
  console.log(`Checking data integrity for project "${options.project}" ${mode}...`);
  console.log("No issues found.");
  console.log("(Phase 0 stub — repair implementation ships in Phase 1)");
}

/**
 * Retrofit pass: walk the project's data tree, run `assignBlockIds`
 * on every `.md` file, write back when the result differs.
 *
 * Skips dotted directories (`.ironlore/`, `.git/`, `.agents/`) so a
 * persona body doesn't compete with the wiki for IDs and so derived
 * state stays unaffected. The walk's exclusion list mirrors the same
 * dotted-dir filter the seeder uses.
 */
function runAddBlockIds(options: RepairOptions): void {
  const baseCwd = options.cwd ?? process.cwd();
  const dataRoot = join(baseCwd, "projects", options.project, "data");
  const files = walkMarkdown(dataRoot);
  if (files.length === 0) {
    console.log(`No markdown files found under ${dataRoot}.`);
    return;
  }

  const dryTag = options.dryRun ? " (dry run)" : "";
  console.log(`\nironlore repair --add-block-ids${dryTag}`);
  console.log("─".repeat(60));
  console.log(`  Project:  ${options.project}`);
  console.log(`  Walked:   ${files.length} markdown files`);

  let stamped = 0;
  let blocksAdded = 0;
  let unchanged = 0;
  for (const filePath of files) {
    let original: string;
    try {
      original = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { markdown: rewritten } = assignBlockIds(original);
    if (rewritten === original) {
      unchanged++;
      continue;
    }
    // Count newly-added IDs by diff'ing the BLOCK_ID regex matches
    //  before and after. The before-count includes pre-existing IDs
    //  that assignBlockIds preserved verbatim, so the delta is the
    //  new stamps only.
    const before = (original.match(/<!-- #blk_[A-Z0-9]{26} -->/g) ?? []).length;
    const after = (rewritten.match(/<!-- #blk_[A-Z0-9]{26} -->/g) ?? []).length;
    blocksAdded += Math.max(0, after - before);
    stamped++;
    if (!options.dryRun) {
      writeFileSync(filePath, rewritten, "utf-8");
    }
  }

  console.log(`  ${options.dryRun ? "Would stamp" : "Stamped"}:  ${stamped} files`);
  console.log(`  Blocks ${options.dryRun ? "to add" : "added"}: ${blocksAdded}`);
  console.log(`  Unchanged:  ${unchanged} files (already fully stamped or no blocks)`);
  console.log("─".repeat(60));
  if (options.dryRun) {
    console.log("  Re-run without --dry-run to apply.");
  } else {
    console.log("  Done.");
  }
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip dotted dirs: .ironlore, .agents (persona prose isn't
      //  vault content), .git. Personas DO benefit from block IDs
      //  on edit, but the retrofit's job is to bring vault wiki/
      //  page content into addressability — not to mutate
      //  agent-internal files behind the user's back.
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(full);
      else if (entry.endsWith(".md")) out.push(full);
    }
  }
  return out;
}
