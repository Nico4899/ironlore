import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Resolve a user-supplied path safely within a project's data root.
 *
 * Both the logical resolve AND the realpath (following symlinks) must land
 * inside `root`. This prevents directory traversal attacks and symlink escapes.
 *
 * @throws {ResolveSafeError} if the resolved path escapes the root
 */
export function resolveSafe(root: string, userPath: string): string {
  const absoluteRoot = resolve(root);
  const prefix = absoluteRoot + sep;

  // Logical resolve — catches ../../../etc/passwd style attacks
  const joined = resolve(absoluteRoot, userPath);
  if (joined !== absoluteRoot && !joined.startsWith(prefix)) {
    throw new ResolveSafeError(userPath, "path escapes project root");
  }

  // Realpath resolve — catches symlink escapes
  let real: string;
  try {
    real = realpathSync(joined);
  } catch {
    // File doesn't exist yet (e.g. creating a new page) — that's fine,
    // the logical check above already passed
    return joined;
  }

  if (real !== absoluteRoot && !real.startsWith(prefix)) {
    throw new ResolveSafeError(userPath, "symlink escapes project root");
  }

  return real;
}

export class ResolveSafeError extends Error {
  override readonly name = "ResolveSafeError";
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`Forbidden path "${path}": ${reason}`);
  }
}
