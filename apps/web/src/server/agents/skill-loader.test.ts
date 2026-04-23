import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills } from "./skill-loader.js";

/**
 * Skill loader — resolution order agent-local → `.shared/`, with
 * explicit opt-in via `declaredSkills`. Fully-on-disk test: no mocks,
 * real files, temp dir per test.
 */

function makeTempDataRoot(): string {
  const dir = join(tmpdir(), `skill-loader-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(
  dataRoot: string,
  location: "shared" | `agent:${string}`,
  name: string,
  body: string,
): void {
  const dir =
    location === "shared"
      ? join(dataRoot, ".agents", ".shared", "skills")
      : join(dataRoot, ".agents", location.slice("agent:".length), "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body, "utf-8");
}

describe("loadSkills", () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = makeTempDataRoot();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("returns empty string when no skills are declared", () => {
    writeSkill(dataRoot, "shared", "lint", "---\nname: Lint\n---\nBody");
    expect(loadSkills(dataRoot, "wiki-gardener", null)).toBe("");
    expect(loadSkills(dataRoot, "wiki-gardener", undefined)).toBe("");
    expect(loadSkills(dataRoot, "wiki-gardener", [])).toBe("");
  });

  it("loads a single shared skill by bare name", () => {
    writeSkill(dataRoot, "shared", "lint", "---\nname: Lint\n---\nLint body text");
    const out = loadSkills(dataRoot, "wiki-gardener", ["lint"]);
    expect(out).toContain("# Loaded skills");
    expect(out).toContain("Lint body text");
    expect(out).not.toContain("---"); // frontmatter stripped
  });

  it("loads a skill whose name carries an explicit .md suffix", () => {
    writeSkill(dataRoot, "shared", "lint", "---\nname: Lint\n---\nLint body text");
    const out = loadSkills(dataRoot, "wiki-gardener", ["lint.md"]);
    expect(out).toContain("Lint body text");
  });

  it("concatenates multiple skills in declaration order", () => {
    writeSkill(dataRoot, "shared", "one", "---\nname: One\n---\nALPHA");
    writeSkill(dataRoot, "shared", "two", "---\nname: Two\n---\nBETA");
    const out = loadSkills(dataRoot, "wiki-gardener", ["one", "two"]);
    expect(out.indexOf("ALPHA")).toBeLessThan(out.indexOf("BETA"));
  });

  it("prefers an agent-local skill over a shared one with the same name (shadowing)", () => {
    writeSkill(dataRoot, "shared", "lint", "---\nname: Shared\n---\nSHARED_LINT");
    writeSkill(dataRoot, "agent:wiki-gardener", "lint", "---\nname: Local\n---\nLOCAL_LINT");
    const out = loadSkills(dataRoot, "wiki-gardener", ["lint"]);
    expect(out).toContain("LOCAL_LINT");
    expect(out).not.toContain("SHARED_LINT");
  });

  it("silently drops skills that don't exist on disk (prompt survives)", () => {
    writeSkill(dataRoot, "shared", "lint", "---\nname: Lint\n---\nLint body");
    const out = loadSkills(dataRoot, "wiki-gardener", ["lint", "doesnotexist"]);
    expect(out).toContain("Lint body");
    expect(out).not.toContain("doesnotexist");
  });

  it("returns empty when every declared skill is missing", () => {
    // No files written.
    expect(loadSkills(dataRoot, "wiki-gardener", ["lint", "orphans"])).toBe("");
  });

  it("handles a skill file with no frontmatter (body-only)", () => {
    writeSkill(dataRoot, "shared", "note", "Just a plain note.");
    const out = loadSkills(dataRoot, "wiki-gardener", ["note"]);
    expect(out).toContain("Just a plain note.");
  });
});
