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
 * Categories:
 *   index-consistency — rebuild FTS5 index (delegates to `reindex`)
 *   schema-migration  — run pending DB migrations (delegates to `migrate`)
 *   data-integrity    — check and repair data (delegates to `repair`)
 *   wal-integrity     — check WAL consistency (future)
 *
 * See docs/02-storage-and-sync.md §Lint-as-migration.
 */

const CATEGORIES = ["index-consistency", "schema-migration", "data-integrity"] as const;
type Category = (typeof CATEGORIES)[number];

function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s);
}

interface LintOptions {
  project: string;
  fix?: boolean;
  check?: string;
  all?: boolean;
}

export function lint(options: LintOptions): void {
  // Validate --check before dispatching so typos surface immediately
  // with a helpful error, not a silent "Unknown check category" line.
  if (options.check && !isCategory(options.check)) {
    console.error(
      `Unknown check category: "${options.check}". ` +
        `Valid categories: ${CATEGORIES.join(", ")}`,
    );
    process.exit(1);
  }

  const categories: Category[] = options.check ? [options.check as Category] : [...CATEGORIES];

  console.log(`\nironlore lint${options.fix ? " --fix" : ""}`);
  console.log("─".repeat(50));

  for (const cat of categories) {
    switch (cat) {
      case "index-consistency":
        console.log(`\n  [${cat}]`);
        if (options.fix) {
          reindex({ project: options.project, all: options.all });
        } else {
          console.log("    Run with --fix to rebuild the FTS5 index.");
        }
        break;

      case "schema-migration":
        console.log(`\n  [${cat}]`);
        migrate();
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
