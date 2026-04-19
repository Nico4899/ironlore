import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, resolveSafe } from "./resolve-safe.js";

/**
 * Phase-8 cross-project escape corpus (docs/05-jobs-and-security.md
 * §Security test suite).
 *
 * Every server-side file access — `/api/projects/:id/pages/*`, raw
 * upload serving, storage-writer page writes, links-registry lookups —
 * funnels user-supplied paths through `resolveSafe`. The function
 * must reject any path whose logical OR realpath-resolved target
 * leaves the project root. This corpus exercises the traversal
 * vectors documented in OWASP "Path Traversal" and adds a few
 * cross-project specific shapes (e.g. attempting to reach sibling
 * project directories under `projects/`).
 *
 * Every payload in `TRAVERSAL_CORPUS` must throw `ForbiddenError`.
 * We also verify a small "benign" set still resolves cleanly so we
 * don't lock down legitimate filenames.
 */

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `ironlore-escape-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

describe("cross-project escape corpus — resolveSafe", () => {
  let root: string;
  let siblingOutside: string;
  const toClean: string[] = [];

  beforeEach(() => {
    root = makeTmpRoot();
    siblingOutside = makeTmpRoot();
    toClean.push(root, siblingOutside);
    writeFileSync(join(siblingOutside, "secrets.md"), "top-secret");
    // A symlink planted inside the project root that escapes to the
    //  sibling — hand-placed symlinks must be rejected unless the
    //  linked-path validator explicitly allows them.
    symlinkSync(siblingOutside, join(root, "planted-link"));
  });

  afterEach(() => {
    for (const d of toClean.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Payloads that MUST be rejected by resolveSafe.
  //
  // Each entry is a user-controllable path that should never resolve
  // inside the project root. Groups are annotated so future additions
  // land in the right bucket.
  // ---------------------------------------------------------------------------

  const TRAVERSAL_CORPUS: Array<{ label: string; path: string }> = [
    // -- classic `..` traversal --
    { label: "single-dotdot", path: "../etc/passwd" },
    { label: "double-dotdot", path: "../../etc/passwd" },
    { label: "deep-dotdot", path: "../../../../../../etc/passwd" },
    { label: "leading-slash-dotdot", path: "/../etc/passwd" },
    { label: "interior-dotdot", path: "sub/../../etc/passwd" },
    { label: "dotdot-with-trailing-slash", path: "../" },
    { label: "dotdot-with-dot", path: "../." },
    { label: "dotdot-alone", path: ".." },

    // -- absolute paths --
    { label: "absolute-etc", path: "/etc/passwd" },
    { label: "absolute-root", path: "/" },
    { label: "absolute-tmp", path: "/tmp/evil" },
    { label: "absolute-home", path: "/root" },

    // Note on null-byte / backslash / space-obfuscated payloads:
    //  on POSIX these normalize to filenames INSIDE the project root,
    //  so they aren't escapes. `resolveSafe`'s contract is narrow —
    //  "does this path leave the project?" — and null-byte-inside-a-
    //  segment collapses after `..` processing to a path in-root. The
    //  fs layer rejects null bytes at write time, and that belongs in
    //  the storage-writer tests.

    // -- interior-dotdot that straddles the root (Windows-style
    //    separator on POSIX just becomes part of a filename) --
    { label: "mixed-slash-escape", path: "../sub/../../etc/passwd" },

    // -- sibling-project reach (the "cross-project" part) --
    { label: "sibling-project", path: "../other-project/data/secrets.md" },
    { label: "sibling-install", path: "../../install.json" },

    // -- symlink escape --
    { label: "planted-symlink", path: "planted-link/secrets.md" },
    { label: "planted-symlink-root", path: "planted-link" },

    // -- CWD / self-reference tricks that still escape --
    { label: "dot-slash-dotdot", path: "./../etc/passwd" },
    { label: "double-dot-chain", path: "./././../../etc/passwd" },
  ];

  for (const { label, path } of TRAVERSAL_CORPUS) {
    it(`rejects escape: ${label} → ${path}`, () => {
      expect(() => resolveSafe(root, path)).toThrow(ForbiddenError);
    });
  }

  it(`covers at least 15 escape payloads (current: ${TRAVERSAL_CORPUS.length})`, () => {
    expect(TRAVERSAL_CORPUS.length).toBeGreaterThanOrEqual(15);
  });

  // ---------------------------------------------------------------------------
  // Benign payloads — must RESOLVE cleanly so we don't over-restrict.
  // ---------------------------------------------------------------------------

  const BENIGN_CORPUS: Array<{ label: string; path: string }> = [
    { label: "simple-file", path: "page.md" },
    { label: "nested-file", path: "sub/page.md" },
    { label: "dot-name", path: ".ironlore-meta" },
    { label: "deep-nested", path: "a/b/c/d/page.md" },
    { label: "unicode-name", path: "日本語.md" },
    { label: "spaces-in-name", path: "my file.md" },
    { label: "hyphens", path: "my-file-name.md" },
    { label: "underscore", path: "_draft.md" },
    { label: "number-prefix", path: "01-intro.md" },
  ];

  for (const { label, path } of BENIGN_CORPUS) {
    it(`allows benign: ${label} → ${path}`, () => {
      expect(() => resolveSafe(root, path)).not.toThrow();
    });
  }

  it(`covers at least 9 benign payloads (current: ${BENIGN_CORPUS.length})`, () => {
    expect(BENIGN_CORPUS.length).toBeGreaterThanOrEqual(9);
  });

  // ---------------------------------------------------------------------------
  // Linked-path validator — the ONE case where a symlink escape is
  // allowed. If the validator returns true for the realpath, the link
  // resolves; otherwise ForbiddenError.
  // ---------------------------------------------------------------------------

  it("linked-path validator allows a registered symlink target", () => {
    // The validator is called with the realpath of the resolved file,
    //  not the symlink itself — so it must accept a child path of the
    //  registered linked directory.
    const validator = (realpath: string) => realpath.startsWith(siblingOutside);
    const resolved = resolveSafe(root, "planted-link/secrets.md", validator);
    expect(resolved).toBe(join(siblingOutside, "secrets.md"));
  });

  it("linked-path validator rejects unregistered targets", () => {
    const validator = () => false;
    expect(() => resolveSafe(root, "planted-link/secrets.md", validator)).toThrow(ForbiddenError);
  });
});
