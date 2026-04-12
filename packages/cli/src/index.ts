#!/usr/bin/env node

import { Command } from "commander";
import { reindex } from "./commands/reindex.js";
import { migrate } from "./commands/migrate.js";
import { repair } from "./commands/repair.js";
import { backup } from "./commands/backup.js";
import { restore } from "./commands/restore.js";

const program = new Command();

program
  .name("ironlore")
  .description("Ironlore — self-hosted knowledge base with AI agents")
  .version("0.0.1");

program
  .command("reindex")
  .description("Rebuild .ironlore/index.sqlite for a project (or all with --all)")
  .option("--all", "Reindex all projects")
  .option("--project <id>", "Project ID to reindex", "main")
  .action(reindex);

program
  .command("migrate")
  .description("Run pending database migrations")
  .action(migrate);

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

program.parse();
