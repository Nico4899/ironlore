import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Callback to check whether a symlink pointing outside the data root is
 * a legitimate linked directory. Used by the LinksRegistry to allow
 * UI-created symlinks while rejecting hand-planted ones.
 *
 * @param realpath - The resolved absolute target of the symlink
 * @returns true if the link is registered and its target has a valid marker
 */
export type LinkedPathValidator = (realpath: string) => boolean;

/**
 * Resolve a user-supplied path safely within a project's data root.
 *
 * Both the logical resolve AND the realpath (following symlinks) must land
 * inside the project root. This prevents directory traversal attacks and
 * symlink escapes.
 *
 * A symlink whose realpath escapes the root is allowed **only if** a
 * `linkedPathValidator` is provided and returns true for the target. This
 * supports the linked-directory feature where external directories are
 * explicitly registered through the UI (see `.ironlore/links.sqlite`).
 *
 * @param projectId - Project data root path. In multi-project (Phase 5) this
 *   will be resolved from a project ID via `projects.dataRoot(projectId)`.
 * @param userPath - Untrusted user-supplied relative path.
 * @param linkedPathValidator - Optional callback for linked-directory validation.
 * @throws {ForbiddenError} if the resolved path escapes the root
 */
export function resolveSafe(
  projectId: string,
  userPath: string,
  linkedPathValidator?: LinkedPathValidator,
): string {
  // Resolve the root itself through realpath so that platform symlinks
  // (e.g. macOS /tmp → /private/tmp) don't cause false rejections.
  let absoluteRoot: string;
  try {
    absoluteRoot = realpathSync(resolve(projectId));
  } catch {
    absoluteRoot = resolve(projectId);
  }
  const prefix = absoluteRoot + sep;

  // Logical resolve — catches ../../../etc/passwd style attacks
  const joined = resolve(absoluteRoot, userPath);
  if (joined !== absoluteRoot && !joined.startsWith(prefix)) {
    throw new ForbiddenError(userPath, "path escapes project root");
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
    // Symlink points outside the root — check if it's a registered link
    if (linkedPathValidator && linkedPathValidator(real)) {
      return real;
    }
    throw new ForbiddenError(userPath, "symlink escapes project root");
  }

  return real;
}

export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`Forbidden path "${path}": ${reason}`);
  }
}
