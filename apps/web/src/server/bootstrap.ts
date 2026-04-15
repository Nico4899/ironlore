import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallRecord } from "@ironlore/core";
import {
  DEFAULT_PROJECT_ID,
  DERIVED_DIR,
  INSTALL_JSON,
  IPC_TOKEN_FILE,
  SENSITIVE_FILE_MODE,
} from "@ironlore/core";
import { ProjectRegistry } from "./project-registry.js";
import { seed } from "./seed.js";

/**
 * Generate a cryptographically random password.
 * 32 random bytes → 48-char base64url string, trimmed to 24 chars.
 */
function generatePassword(): string {
  return randomBytes(32).toString("base64url").slice(0, 24);
}

/**
 * Write a file with restricted permissions (mode 0600).
 */
function writeRestricted(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: SENSITIVE_FILE_MODE });
}

/**
 * Bootstrap the Ironlore install on first run.
 *
 * 1. Ensure directory structure exists (projects/main/data/).
 * 2. Generate .ironlore-install.json with admin credentials if missing.
 * 3. Generate ipc.token for worker ↔ web authentication.
 * 4. Run non-destructive first-run seeding.
 */
export async function bootstrap(installRoot: string): Promise<void> {
  const projectDir = join(installRoot, "projects", DEFAULT_PROJECT_ID);
  const dataDir = join(projectDir, "data");

  // Ensure directory structure
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(projectDir, DERIVED_DIR), { recursive: true });
  mkdirSync(join(projectDir, DERIVED_DIR, "locks"), { recursive: true });
  mkdirSync(join(projectDir, DERIVED_DIR, "wal"), { recursive: true });

  // Generate install record if this is a fresh install
  const installJsonPath = join(installRoot, INSTALL_JSON);
  if (!existsSync(installJsonPath)) {
    const record: InstallRecord = {
      admin_username: "admin",
      initial_password: generatePassword(),
      created_at: new Date().toISOString(),
    };
    writeRestricted(installJsonPath, JSON.stringify(record, null, 2));

    console.log("─".repeat(60));
    console.log("  Ironlore — first run");
    console.log("─".repeat(60));
    console.log(`  Admin username: ${record.admin_username}`);
    console.log(`  Admin password: ${record.initial_password}`);
    console.log("─".repeat(60));
    console.log("  Save this password now — it will not be shown again.");
    console.log("  You will be asked to change it on first login.");
    console.log("─".repeat(60));
  }

  // Rotate IPC token on every startup
  const ipcTokenPath = join(installRoot, IPC_TOKEN_FILE);
  const token = randomBytes(32).toString("hex");
  writeRestricted(ipcTokenPath, token);

  // Ensure default project is registered
  const registry = new ProjectRegistry(installRoot);
  registry.ensureProject(DEFAULT_PROJECT_ID, "Main", "main");
  registry.close();

  // Seed content (non-destructive: skips existing files)
  await seed(dataDir);
}
