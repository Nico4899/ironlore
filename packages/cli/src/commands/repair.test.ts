import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repair } from "./repair.js";

/**
 * `ironlore repair --add-block-ids` retrofit tests.
 *
 * Pins three contracts:
 *   1. Walks every `.md` under `projects/<id>/data/`, stamps any
 *      block missing a `<!-- #blk_… -->` ID, leaves files where
 *      every block is already stamped untouched.
 *   2. `--dry-run` previews without writing — file bytes don't change.
 *   3. Idempotent: a second invocation against an already-stamped
 *      vault is a no-op (zero stamps, zero blocks added).
 */

function makeTmpProject(): { cwd: string; dataRoot: string } {
  const cwd = join(tmpdir(), `repair-cli-test-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(cwd, "projects", "main", "data");
  mkdirSync(dataRoot, { recursive: true });
  return { cwd, dataRoot };
}

describe("repair --add-block-ids", () => {
  let cwd: string;
  let dataRoot: string;
  // biome-ignore lint/suspicious/noExplicitAny: vi.spyOn generic signature drift
  let logSpy: any;

  beforeEach(() => {
    const tmp = makeTmpProject();
    cwd = tmp.cwd;
    dataRoot = tmp.dataRoot;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("stamps block IDs on markdown that has none", () => {
    const path = join(dataRoot, "page.md");
    writeFileSync(path, "# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n", "utf-8");

    repair({ project: "main", addBlockIds: true, cwd });

    const after = readFileSync(path, "utf-8");
    const stamps = after.match(/<!-- #blk_[A-Z0-9]{26} -->/g) ?? [];
    expect(stamps.length).toBeGreaterThanOrEqual(3); // heading + 2 paragraphs
    expect(after).toMatch(/^# Heading <!-- #blk_/m);
  });

  it("preserves existing IDs and only stamps the missing ones", () => {
    const path = join(dataRoot, "mixed.md");
    const original =
      "# Heading <!-- #blk_01HABCABCABCABCABCABCABCAA -->\n\n" +
      "Already stamped paragraph. <!-- #blk_01HABCABCABCABCABCABCABCAB -->\n\n" +
      "Unstamped paragraph.\n";
    writeFileSync(path, original, "utf-8");

    repair({ project: "main", addBlockIds: true, cwd });

    const after = readFileSync(path, "utf-8");
    // Pre-existing IDs must survive verbatim.
    expect(after).toContain("blk_01HABCABCABCABCABCABCABCAA");
    expect(after).toContain("blk_01HABCABCABCABCABCABCABCAB");
    // The unstamped paragraph picked up a new ID.
    const stamps = after.match(/<!-- #blk_[A-Z0-9]{26} -->/g) ?? [];
    expect(stamps.length).toBe(3);
  });

  it("is idempotent — re-running against a fully-stamped vault is a no-op", () => {
    const path = join(dataRoot, "stamped.md");
    writeFileSync(path, "# Heading\n\nA paragraph.\n", "utf-8");

    repair({ project: "main", addBlockIds: true, cwd });
    const after1 = readFileSync(path, "utf-8");

    // Second pass: should not change a single byte.
    repair({ project: "main", addBlockIds: true, cwd });
    const after2 = readFileSync(path, "utf-8");

    expect(after2).toBe(after1);
  });

  it("--dry-run reports what would change without touching disk", () => {
    const path = join(dataRoot, "preview.md");
    const original = "# Heading\n\nA paragraph.\n";
    writeFileSync(path, original, "utf-8");

    repair({ project: "main", addBlockIds: true, dryRun: true, cwd });

    const after = readFileSync(path, "utf-8");
    expect(after).toBe(original);
    expect(
      logSpy.mock.calls.some((call: unknown[]) =>
        String((call as unknown[])[0]).includes("Re-run without --dry-run"),
      ),
    ).toBe(true);
  });

  it("skips dotted directories (.agents, .ironlore) — agent prose isn't retrofitted", () => {
    const agentsPath = join(dataRoot, ".agents");
    mkdirSync(agentsPath, { recursive: true });
    const personaPath = join(agentsPath, "general", "persona.md");
    mkdirSync(join(agentsPath, "general"), { recursive: true });
    const personaOriginal = "# Persona\n\nNo IDs here.\n";
    writeFileSync(personaPath, personaOriginal, "utf-8");

    // Also a normal page that SHOULD be stamped.
    const normalPath = join(dataRoot, "regular.md");
    writeFileSync(normalPath, "# Regular\n\nStamp me.\n", "utf-8");

    repair({ project: "main", addBlockIds: true, cwd });

    expect(readFileSync(personaPath, "utf-8")).toBe(personaOriginal);
    expect(readFileSync(normalPath, "utf-8")).toMatch(/<!-- #blk_/);
  });

  it("handles a vault with zero markdown files without crashing", () => {
    expect(() => repair({ project: "main", addBlockIds: true, cwd })).not.toThrow();
    expect(
      logSpy.mock.calls.some((call: unknown[]) =>
        String((call as unknown[])[0]).includes("No markdown files found"),
      ),
    ).toBe(true);
  });
});
