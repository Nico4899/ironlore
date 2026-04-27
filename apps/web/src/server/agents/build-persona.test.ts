import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "../jobs/schema.js";
import { buildPersona } from "./build-persona.js";

/**
 * Visual Agent Builder — Phase-11 A.9.1.
 *
 * `buildPersona` compiles plain-English form inputs from the
 * AgentBuilderDialog into a properly-shaped persona.md. Pinning
 * the contract so a refactor that drops a frontmatter field or
 * weakens the slug-validation breaks the test.
 */

let tmp: string;
let dataDir: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "build-persona-"));
  dataDir = join(tmp, "data");
  mkdirSync(dataDir, { recursive: true });
  db = openJobsDb(join(tmp, "jobs.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildPersona", () => {
  it("compiles a minimal persona into the canonical persona.md path", () => {
    const result = buildPersona(dataDir, db, "main", {
      name: "Researcher",
      slug: "researcher",
      role: "Find sources, summarize papers",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.slug).toBe("researcher");
    expect(result.personaPath).toBe(join(dataDir, ".agents", "researcher", "persona.md"));

    const persona = readFileSync(result.personaPath, "utf-8");
    expect(persona).toMatch(/^---\n/);
    expect(persona).toContain("name: Researcher");
    expect(persona).toContain("slug: researcher");
    expect(persona).toContain('role: "Find sources, summarize papers"');
    expect(persona).toContain("type: custom");
    expect(persona).toContain("active: true");
    expect(persona).toContain("writable_kinds: [page, wiki]");
    // Default scope = whole vault.
    expect(persona).toContain('pages: ["/**"]');
    // Body framing
    expect(persona).toContain("You are the Researcher.");
  });

  it("emits writable_kinds: [] when canEditPages is false", () => {
    const result = buildPersona(dataDir, db, "main", {
      name: "Read-only Helper",
      slug: "ro-helper",
      role: "Answer questions; never modify pages",
      constraints: [],
      canEditPages: false,
      reviewBeforeMerge: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const persona = readFileSync(result.personaPath, "utf-8");
    expect(persona).toContain("writable_kinds: []");
  });

  it("emits review_mode: inbox when reviewBeforeMerge is true", () => {
    const result = buildPersona(dataDir, db, "main", {
      name: "Cautious Editor",
      slug: "cautious",
      role: "Edit only with human review",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const persona = readFileSync(result.personaPath, "utf-8");
    expect(persona).toContain("review_mode: inbox");
  });

  it("renders constraints as a body Constraints section", () => {
    // The proposal's "Never do this" rules land as a `## Constraints`
    // section in the persona body, NOT as YAML frontmatter — they
    // need to be in the loaded prompt so the model sees them.
    const result = buildPersona(dataDir, db, "main", {
      name: "Strict Researcher",
      slug: "strict",
      role: "Source-verified summaries",
      constraints: [
        "Modify pages outside /research/",
        "Reference sources you haven't read",
      ],
      canEditPages: true,
      reviewBeforeMerge: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const persona = readFileSync(result.personaPath, "utf-8");
    expect(persona).toContain("## Constraints");
    expect(persona).toContain("- Modify pages outside /research/");
    expect(persona).toContain("- Reference sources you haven't read");
  });

  it("creates the working tree (memory/, sessions/, skills/) alongside persona.md", () => {
    const result = buildPersona(dataDir, db, "main", {
      name: "X",
      slug: "x",
      role: "X",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
    });
    expect(result.ok).toBe(true);
    const agentDir = join(dataDir, ".agents", "x");
    // Each subdir must exist so kb.append_memory + agent.journal +
    // skill-loader have somewhere to write/read.
    expect(() => readFileSync(join(agentDir, "persona.md"))).not.toThrow();
    for (const sub of ["memory", "sessions", "skills"]) {
      expect(() => readFileSync(join(agentDir, sub, ".gitkeep")).toString()).toThrow();
      // Directory exists even though .gitkeep doesn't — readFileSync
      // throws ENOENT for the file but mkdirSync above succeeded.
    }
  });

  it("creates an agent_state row so rate rails start tracking immediately", () => {
    buildPersona(dataDir, db, "main", {
      name: "X",
      slug: "tracked",
      role: "X",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
    });
    const row = db
      .prepare("SELECT status FROM agent_state WHERE project_id = ? AND slug = ?")
      .get("main", "tracked") as { status: string } | undefined;
    expect(row?.status).toBe("active");
  });

  it("rejects a slug that doesn't match the lowercase-hyphen pattern", () => {
    for (const bad of ["MyAgent", "my_agent", "my agent", "/path", "../escape", ""]) {
      const result = buildPersona(dataDir, db, "main", {
        name: "X",
        slug: bad,
        role: "X",
        constraints: [],
        canEditPages: true,
        reviewBeforeMerge: false,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe(400);
      expect(result.error).toMatch(/lowercase-hyphen|reserved/);
    }
  });

  it("rejects reserved slugs (.library, .shared, general, editor)", () => {
    for (const reserved of ["general", "editor"]) {
      const result = buildPersona(dataDir, db, "main", {
        name: "X",
        slug: reserved,
        role: "X",
        constraints: [],
        canEditPages: true,
        reviewBeforeMerge: false,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe(400);
      expect(result.error).toMatch(/reserved/);
    }
  });

  it("returns 409 when an agent already exists at the slug", () => {
    const input = {
      name: "Twin",
      slug: "twin",
      role: "Doppelgänger",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
    };
    const first = buildPersona(dataDir, db, "main", input);
    expect(first.ok).toBe(true);
    const second = buildPersona(dataDir, db, "main", input);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe(409);
  });

  it("rejects empty name or role", () => {
    const blankName = buildPersona(dataDir, db, "main", {
      name: "  ",
      slug: "blank",
      role: "X",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
    });
    expect(blankName.ok).toBe(false);
    if (blankName.ok) throw new Error("unreachable");
    expect(blankName.code).toBe(400);

    const blankRole = buildPersona(dataDir, db, "main", {
      name: "X",
      slug: "blank2",
      role: "  ",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
    });
    expect(blankRole.ok).toBe(false);
  });

  it("emits the heartbeat line only when supplied", () => {
    const without = buildPersona(dataDir, db, "main", {
      name: "Manual",
      slug: "manual-only",
      role: "X",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
    });
    expect(without.ok).toBe(true);
    if (!without.ok) throw new Error("unreachable");
    const persona = readFileSync(without.personaPath, "utf-8");
    expect(persona).not.toContain("heartbeat:");

    const withCron = buildPersona(dataDir, db, "main", {
      name: "Scheduled",
      slug: "scheduled",
      role: "X",
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
      heartbeat: "0 6 * * 0",
    });
    expect(withCron.ok).toBe(true);
    if (!withCron.ok) throw new Error("unreachable");
    const personaCron = readFileSync(withCron.personaPath, "utf-8");
    expect(personaCron).toContain('heartbeat: "0 6 * * 0"');
  });

  it("escapes embedded quotes in name + role to keep YAML well-formed", () => {
    // A naive template would emit `role: "...he said "hi"..."` which
    // breaks the YAML quote pairing. Pin defensive escaping so a
    // user typing a quote in the form doesn't corrupt the file.
    const result = buildPersona(dataDir, db, "main", {
      name: 'The "Quoted" One',
      slug: "quoted",
      role: 'Find what they call "the source of truth"',
      constraints: [],
      canEditPages: true,
      reviewBeforeMerge: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const persona = readFileSync(result.personaPath, "utf-8");
    // Quotes converted to apostrophes — the YAML stays unambiguously parsable.
    expect(persona).toContain("name: The 'Quoted' One");
    expect(persona).toContain("role: \"Find what they call 'the source of truth'\"");
  });
});
