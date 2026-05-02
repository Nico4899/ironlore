import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLibraryTemplates } from "./library.js";

/**
 * `listLibraryTemplates()` contract tests — the function the Settings
 * → Agents "Library" section reads. Exercises both library layouts,
 * frontmatter parsing, and the activated-slug filter.
 */

function makeDataDir(): string {
  const dir = join(tmpdir(), `library-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFlat(dataDir: string, slug: string, frontmatter: string): void {
  const dir = join(dataDir, ".agents", ".library");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\nslug: ${slug}\n${frontmatter}\n---\n\nbody\n`,
    "utf-8",
  );
}

function writeDir(dataDir: string, slug: string, frontmatter: string): void {
  const dir = join(dataDir, ".agents", ".library", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "persona.md"),
    `---\nslug: ${slug}\n${frontmatter}\n---\n\nbody\n`,
    "utf-8",
  );
}

function writeActivated(dataDir: string, slug: string): void {
  const dir = join(dataDir, ".agents", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "persona.md"), `---\nslug: ${slug}\nactive: true\n---\n`, "utf-8");
}

describe("listLibraryTemplates", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty array when the library directory does not exist", () => {
    // No .agents/.library/ on disk at all.
    expect(listLibraryTemplates(dataDir)).toEqual([]);
  });

  it("lists flat .library/<slug>.md templates with parsed frontmatter", () => {
    writeFlat(
      dataDir,
      "wiki-gardener",
      `name: Wiki Gardener
emoji: "🌿"
role: "Wiki health — orphan detection, stale pages, link rot"
department: Maintenance
heartbeat: "0 6 * * 0"`,
    );
    const rows = listLibraryTemplates(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      slug: "wiki-gardener",
      name: "Wiki Gardener",
      emoji: "🌿",
      role: "Wiki health — orphan detection, stale pages, link rot",
      department: "Maintenance",
      heartbeat: "0 6 * * 0",
      description: "Wiki health — orphan detection, stale pages, link rot",
    });
  });

  it("lists directory-style .library/<slug>/persona.md templates", () => {
    writeDir(dataDir, "researcher", `name: Researcher\nrole: "Thesis-driven research"`);
    const rows = listLibraryTemplates(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("researcher");
    expect(rows[0]?.name).toBe("Researcher");
  });

  it("filters out templates whose activated counterpart exists", () => {
    writeFlat(dataDir, "wiki-gardener", `name: Wiki Gardener`);
    // Generic fixture slug — the listing path is template-agnostic,
    //  so any user-built persona on disk should pass through.
    writeFlat(dataDir, "release-drafter", `name: Release Drafter`);
    writeActivated(dataDir, "wiki-gardener"); // already running

    const rows = listLibraryTemplates(dataDir);
    expect(rows.map((r) => r.slug)).toEqual(["release-drafter"]);
  });

  it("sorts by department first, then slug alphabetically", () => {
    // Fixture-only slugs — these don't ship as seeded personas; we
    //  exercise the sort with department names that produce a clear
    //  alphabetical ordering across two slugs in the same department.
    writeFlat(dataDir, "pr-reviewer", `name: PR Reviewer\ndepartment: Engineering`);
    writeFlat(dataDir, "release-drafter", `name: Release Drafter\ndepartment: Engineering`);
    writeFlat(dataDir, "wiki-gardener", `name: Gardener\ndepartment: Maintenance`);
    writeFlat(dataDir, "meeting-summarizer", `name: Summarizer\ndepartment: Operations`);

    const rows = listLibraryTemplates(dataDir);
    expect(rows.map((r) => r.slug)).toEqual([
      "pr-reviewer",
      "release-drafter",
      "wiki-gardener",
      "meeting-summarizer",
    ]);
  });

  it("places department-less templates at the end of the list", () => {
    writeFlat(dataDir, "classified", `name: C\ndepartment: Marketing`);
    writeFlat(dataDir, "misc", `name: M`); // no department
    const rows = listLibraryTemplates(dataDir);
    expect(rows.map((r) => r.slug)).toEqual(["classified", "misc"]);
  });

  it("falls back to role when description is absent", () => {
    writeFlat(dataDir, "release-drafter", `role: "Drafts release notes from merged PRs"`);
    const rows = listLibraryTemplates(dataDir);
    expect(rows[0]?.description).toBe("Drafts release notes from merged PRs");
  });

  it("prefers an explicit description over role", () => {
    writeFlat(
      dataDir,
      "release-drafter",
      `role: "Strategy"\ndescription: "Sets the weekly cadence and owns the decision log"`,
    );
    const rows = listLibraryTemplates(dataDir);
    expect(rows[0]?.description).toBe("Sets the weekly cadence and owns the decision log");
  });

  it("returns a null-filled row for a malformed template rather than crashing", () => {
    // No frontmatter at all — the slug alone must still surface so the
    // user can recognize and delete the bad file.
    const libDir = join(dataDir, ".agents", ".library");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, "broken.md"), "no frontmatter here\n", "utf-8");

    const rows = listLibraryTemplates(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("broken");
    expect(rows[0]?.name).toBeNull();
    expect(rows[0]?.role).toBeNull();
  });

  // Bug 5 regression — the library directory ships an `index.md`
  // README (page-shaped frontmatter, no template fields) plus may
  // accumulate `_*` notes. Both produced ghost rows in the listing
  // with `slug: "index"` / `slug: "_notes"` and all-null fields.
  // Filter by reserved name so they never reach the listing.

  it("does not surface index.md as a library template", () => {
    const libDir = join(dataDir, ".agents", ".library");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      join(libDir, "index.md"),
      "---\nschema: 1\nid: 01ABC\ntitle: Agent Library\nkind: page\n---\n\n# Agent Library\n",
      "utf-8",
    );
    writeFlat(dataDir, "wiki-gardener", `name: Wiki Gardener`);

    const rows = listLibraryTemplates(dataDir);
    expect(rows.map((r) => r.slug)).toEqual(["wiki-gardener"]);
  });

  it("does not surface `_*` files as library templates", () => {
    const libDir = join(dataDir, ".agents", ".library");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      join(libDir, "_notes.md"),
      "---\nname: Internal Notes\n---\n",
      "utf-8",
    );
    writeFlat(dataDir, "wiki-gardener", `name: Wiki Gardener`);

    const rows = listLibraryTemplates(dataDir);
    expect(rows.map((r) => r.slug)).toEqual(["wiki-gardener"]);
  });
});
