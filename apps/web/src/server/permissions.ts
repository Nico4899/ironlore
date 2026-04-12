import { statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROJECT_ID,
  INSTALL_JSON,
  IPC_TOKEN_FILE,
  SENSITIVE_FILE_MODE,
} from "@ironlore/core";

/**
 * Sensitive files that must have POSIX mode 0600 (owner read/write only).
 * Relative to the install root unless noted otherwise.
 */
const SENSITIVE_FILES = [
  IPC_TOKEN_FILE,
  INSTALL_JSON,
  "password.salt",
  "sessions.sqlite",
  "projects.sqlite",
];

/**
 * Per-project sensitive files, relative to the project directory.
 */
const PROJECT_SENSITIVE_FILES = [".ironlore/api-keys.enc"];

/**
 * Check that all sensitive files have restricted permissions (mode 0600).
 *
 * Returns a list of violations. If the list is non-empty, the server
 * should refuse to start. Skipped on Windows where POSIX modes are
 * not meaningful.
 */
export function checkPermissions(installRoot: string): string[] {
  // Skip on Windows — POSIX modes not applicable
  if (process.platform === "win32") return [];

  const violations: string[] = [];

  // Check install-root level files
  for (const file of SENSITIVE_FILES) {
    checkFile(join(installRoot, file), violations);
  }

  // Check per-project sensitive files (default project)
  const projectDir = join(installRoot, "projects", DEFAULT_PROJECT_ID);
  for (const file of PROJECT_SENSITIVE_FILES) {
    checkFile(join(projectDir, file), violations);
  }

  return violations;
}

function checkFile(absPath: string, violations: string[]): void {
  try {
    const stat = statSync(absPath);
    // Extract permission bits (lower 9 bits)
    const mode = stat.mode & 0o777;
    if (mode !== SENSITIVE_FILE_MODE) {
      violations.push(
        `${absPath}: mode ${mode.toString(8).padStart(4, "0")} is broader than ` +
          `${SENSITIVE_FILE_MODE.toString(8).padStart(4, "0")}. ` +
          `Fix with: chmod 600 "${absPath}"`,
      );
    }
  } catch {
    // File doesn't exist yet — that's fine, it will be created with
    // correct permissions on first use.
  }
}
