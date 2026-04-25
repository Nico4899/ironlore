#!/usr/bin/env node

import { Command } from "commander";
import { backup } from "./commands/backup.js";
import { evalCommand } from "./commands/eval.js";
import { flush } from "./commands/flush.js";
import { lint } from "./commands/lint.js";
import { migrate } from "./commands/migrate.js";
import { newProject } from "./commands/new-project.js";
import { reindex } from "./commands/reindex.js";
import { repair } from "./commands/repair.js";
import { restore } from "./commands/restore.js";
import { userAdd } from "./commands/user.js";

const program = new Command();

program
  .name("ironlore")
  .description("Ironlore — self-hosted knowledge base with AI agents")
  .version("0.0.1");

program
  .command("lint")
  .description("Check and fix data integrity, index consistency, and schema migrations")
  .option("--project <id>", "Project ID to lint", "main")
  .option("--fix", "Auto-repair issues (default: report only)")
  .option(
    "--check <category>",
    "Run a single check category (index-consistency, schema-migration, data-integrity)",
  )
  .option("--all", "Lint all projects (for index-consistency)")
  .action(lint);

program
  .command("reindex")
  .description("Rebuild .ironlore/index.sqlite for a project (or all with --all)")
  .option("--all", "Reindex all projects")
  .option("--project <id>", "Project ID to reindex", "main")
  .action(reindex);

program
  .command("flush")
  .description("Drain all pending WAL entries into git immediately")
  .option("--project <id>", "Project ID to flush", "main")
  .action(flush);

program.command("migrate").description("Run pending database migrations").action(migrate);

program
  .command("repair")
  .description("Check and repair data integrity")
  .option("--project <id>", "Project ID to repair", "main")
  .option("--dry-run", "Report issues without fixing")
  .action(repair);

program
  .command("backup")
  .description("Create a backup archive of the knowledge base")
  .option("--project <id>", "Project ID to backup", "main")
  .option("-o, --output <path>", "Output path for the archive")
  .action(backup);

program
  .command("restore")
  .description("Restore from a backup archive")
  .argument("<archive>", "Path to the backup archive")
  .option("--project <id>", "Project ID to restore into", "main")
  .action(restore);

program
  .command("eval")
  .description("Read-only perf + quality scorecard for a project (exit 0/1 for CI)")
  .option("--project <id>", "Project ID to evaluate", "main")
  .option("--json", "Machine-readable JSON output")
  .option("--perf-only", "Run performance benchmarks only")
  .option("--quality-only", "Run quality checks only")
  .action((opts) =>
    evalCommand({
      project: opts.project,
      json: opts.json ?? false,
      perfOnly: opts.perfOnly ?? false,
      qualityOnly: opts.qualityOnly ?? false,
    }),
  );

program
  .command("new-project")
  .description("Scaffold a new project under projects/<id>/ (restart server to mount)")
  .argument("<id>", "Project id (filesystem-safe slug)")
  .option("--name <name>", "Human-readable name (defaults to id)")
  .option("--preset <preset>", "Preset: main | research | sandbox", "main")
  .action((id, opts: { name?: string; preset: "main" | "research" | "sandbox" }) =>
    newProject(id, opts),
  );

program
  .command("user")
  .description("Manage users (multi-user mode)")
  .addCommand(
    new Command("add")
      .description("Provision a new user; prints initial password to stdout once")
      .argument("<username>", "Username (alphanumerics, '.', '_', '-')")
      .option("--install-root <path>", "Install root (defaults to cwd)")
      .action(async (username: string, opts: { installRoot?: string }) => {
        try {
          await userAdd(username, { installRoot: opts.installRoot });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }),
  );

program.parse();
