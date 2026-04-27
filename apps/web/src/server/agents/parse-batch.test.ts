import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBatchOptIn } from "./executor.js";

/**
 * `parseBatchOptIn` reads the `batch: true | false` flag from a
 * persona's YAML frontmatter. It's the per-persona switch into
 * the Phase-11 async batch path documented at
 * docs/04-ai-and-agents.md §Batch API.
 *
 * Pinning the regex semantics here (not via a YAML parser) means
 * a refactor that drops the strict start-of-line match — and
 * therefore lets a nested `  batch: true` enable batch mode for a
 * persona that didn't ask for it — will fail the test instead of
 * silently changing cost.
 */

let dataDir: string;

function writePersona(slug: string, frontmatter: string): void {
  const dir = join(dataDir, ".agents", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "persona.md"),
    `---\nslug: ${slug}\n${frontmatter}\n---\n\nBody.\n`,
    "utf-8",
  );
}

describe("parseBatchOptIn", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), `parse-batch-${randomBytes(4).toString("hex")}-`));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns false when the persona file is missing (test fixtures, fresh installs)", () => {
    expect(parseBatchOptIn(dataDir, "ghost")).toBe(false);
  });

  it("returns false when the persona has no `batch:` field", () => {
    writePersona("plain", "active: true");
    expect(parseBatchOptIn(dataDir, "plain")).toBe(false);
  });

  it("returns true when the persona declares `batch: true`", () => {
    writePersona("gardener", "active: true\nbatch: true");
    expect(parseBatchOptIn(dataDir, "gardener")).toBe(true);
  });

  it("returns false when the persona explicitly opts out with `batch: false`", () => {
    writePersona("editor", "active: true\nbatch: false");
    expect(parseBatchOptIn(dataDir, "editor")).toBe(false);
  });

  it("ignores indented `batch: true` (anti-spoof — must be top-level scalar)", () => {
    // A nested key under some other field shouldn't accidentally
    // enable batch mode. The regex requires `batch:` at start of
    // line, no leading whitespace, mirroring the writable-kinds
    // gate's posture.
    writePersona("trick", "active: true\nscope:\n  batch: true");
    expect(parseBatchOptIn(dataDir, "trick")).toBe(false);
  });

  it("ignores trailing tokens — only `true`/`false` literals count", () => {
    writePersona("typo", "active: true\nbatch: yes");
    expect(parseBatchOptIn(dataDir, "typo")).toBe(false);
  });
});
