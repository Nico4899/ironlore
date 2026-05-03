import { lintProvenance } from "./lint-provenance.js";
import { lintStructure } from "./lint-structure.js";
import { lintWalIntegrity } from "./lint-wal.js";
import { migrate } from "./migrate.js";
import { reindex } from "./reindex.js";
import { repair } from "./repair.js";

/**
 * `ironlore lint` — unified check/fix command.
 *
 * Subsumes `reindex`, `migrate`, and `repair` as check categories.
 * Running `ironlore lint` with no flags runs all categories in
 * report-only mode. `--fix` auto-repairs what it can. `--check <cat>`
 * scopes to a single category.
 *
 * Categories (per docs/02-storage-and-sync.md §Lint-as-migration):
 *   wal-integrity     — uncommitted WAL entries from a crash; --fix
 *                       replays writes / marks committed for the
 *                       recoverable cases. The "neither hash matches"
 *                       case is surfaced for manual review per the
 *                       doc's no-clobber rule.
 *   index-consistency — rebuild FTS5 + chunk + context indexes
 *                       (delegates to `reindex`)
 *   schema-migration  — run pending DB migrations (delegates to `migrate`)
 *   structure         — orphan pages + coverage gaps (informational)
 *   provenance        — agent-authored blocks missing `derived_from` (informational)
 *   data-integrity    — check and repair data (delegates to `repair`)
 */

const CATEGORIES = [
  "wal-integrity",
  "index-consistency",
  "schema-migration",
  "structure",
  "provenance",
  "data-integrity",
] as const;
type Category = (typeof CATEGORIES)[number];

function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s);
}

interface LintOptions {
  project: string;
  fix?: boolean;
  check?: string;
  /** New canonical flag — `--all-projects` (commander camelCases). */
  allProjects?: boolean;
  /** Legacy alias — `--all`. Deprecated; logs a one-line warning. */
  all?: boolean;
}

export function lint(options: LintOptions): void {
  // Validate --check before dispatching so typos surface immediately
  // with a helpful error, not a silent "Unknown check category" line.
  if (options.check && !isCategory(options.check)) {
    console.error(
      `Unknown check category: "${options.check}". ` + `Valid categories: ${CATEGORIES.join(", ")}`,
    );
    process.exit(1);
  }

  // Resolve the all-projects flag from either form. The legacy
  //  `--all` was confusing because it overloaded the word "all" —
  //  callers reasonably expected it to mean "all check categories"
  //  given the surrounding `--check <category>` flag. Renamed to
  //  `--all-projects` for clarity; the legacy spelling still works
  //  but warns once so scripts get nudged toward the new name.
  if (options.all && !options.allProjects) {
    console.warn(
      "ironlore: `--all` is deprecated; use `--all-projects` instead. " +
        "(The flag scope is unchanged: index-consistency across every project.)",
    );
  }
  const allProjects = options.allProjects ?? options.all ?? false;

  const categories: Category[] = options.check ? [options.check as Category] : [...CATEGORIES];

  console.log(`\nironlore lint${options.fix ? " --fix" : ""}`);
  console.log("─".repeat(50));

  for (const cat of categories) {
    switch (cat) {
      case "wal-integrity":
        console.log(`\n  [${cat}]`);
        lintWalIntegrity({ project: options.project, fix: options.fix });
        break;

      case "index-consistency":
        console.log(`\n  [${cat}]`);
        if (options.fix) {
          reindex({ project: options.project, all: allProjects });
        } else {
          console.log("    Run with --fix to rebuild the FTS5 index.");
        }
        break;

      case "schema-migration":
        console.log(`\n  [${cat}]`);
        migrate();
        break;

      case "structure":
        console.log(`\n  [${cat}]`);
        lintStructure({ project: options.project, fix: options.fix });
        break;

      case "provenance":
        console.log(`\n  [${cat}]`);
        lintProvenance({ project: options.project, fix: options.fix });
        break;

      case "data-integrity":
        console.log(`\n  [${cat}]`);
        repair({ project: options.project, dryRun: !options.fix });
        break;
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log("  All checks passed.");
}
