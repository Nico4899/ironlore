import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "../jobs/schema.js";
import { seedAgents } from "./seed-agents.js";

/**
 * `seedAgents()` plants the default agents (Librarian + Editor),
 * library templates (Researcher), and the shared skills directory.
 * The researcher carries a dedicated `thesis.md` skill that earns
 * the persona its place in the curated library — without it, the
 * library trio's three-personas-with-distinct-tooling promise
 * breaks (see docs/04-ai-and-agents.md §Default agents).
 */

function makeTempInstall(): { dataDir: string; jobsDb: Database.Database; cleanup: () => void } {
  const installRoot = join(tmpdir(), `seed-agents-test-${randomBytes(4).toString("hex")}`);
  const dataDir = join(installRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  const jobsDb = openJobsDb(installRoot);
  return {
    dataDir,
    jobsDb,
    cleanup: () => {
      jobsDb.close();
      rmSync(installRoot, { recursive: true, force: true });
    },
  };
}

describe("seedAgents — default agents + library templates", () => {
  let dataDir: string;
  let jobsDb: Database.Database;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dataDir, jobsDb, cleanup } = makeTempInstall());
  });

  afterEach(() => {
    cleanup();
  });

  it("seeds the Librarian (slug: general) persona", () => {
    seedAgents(dataDir, jobsDb);
    const personaPath = join(dataDir, ".agents", "general", "persona.md");
    expect(existsSync(personaPath)).toBe(true);
    const content = readFileSync(personaPath, "utf-8");
    expect(content).toMatch(/\nname: Librarian\n/);
    expect(content).toMatch(/\nslug: general\n/);
  });

  it("seeds the Editor persona with writable_kinds: [page, wiki]", () => {
    seedAgents(dataDir, jobsDb);
    const personaPath = join(dataDir, ".agents", "editor", "persona.md");
    expect(existsSync(personaPath)).toBe(true);
    const content = readFileSync(personaPath, "utf-8");
    expect(content).toMatch(/\nname: Editor\n/);
    expect(content).toMatch(/writable_kinds: \["page","wiki"\]/);
  });

  it("seeds the Researcher library template", () => {
    seedAgents(dataDir, jobsDb);
    const personaPath = join(dataDir, ".agents", ".library", "researcher", "persona.md");
    expect(existsSync(personaPath)).toBe(true);
    const content = readFileSync(personaPath, "utf-8");
    expect(content).toMatch(/\nname: Researcher\n/);
    expect(content).toMatch(/\nslug: researcher\n/);
    expect(content).toMatch(/\nskills: \[thesis\]\n/);
  });

  it("seeds the Researcher's agent-local thesis.md skill", () => {
    seedAgents(dataDir, jobsDb);
    const skillPath = join(
      dataDir,
      ".agents",
      ".library",
      "researcher",
      "skills",
      "thesis.md",
    );
    expect(existsSync(skillPath)).toBe(true);
    const content = readFileSync(skillPath, "utf-8");
    // Frontmatter shape so the skill loader can pick it up.
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/\nname: Thesis-driven investigation\n/);
    // Workflow steps the doc spec pins (decompose → support → oppose
    //  → compile → verdict). The exact wording can drift; the verdict
    //  labels and the anti-confirmation rule are the load-bearing
    //  invariants.
    expect(content).toContain("decompose");
    for (const verdict of ["supported", "contradicted", "mixed", "insufficient"]) {
      expect(content).toContain(verdict);
    }
    // The anti-confirmation-bias rule is what makes the skill more
    //  than a one-shot prompt; pin its presence so a future seed
    //  rewrite that drops it breaks the test loudly.
    expect(content).toMatch(/anti-confirmation-bias/i);
    expect(content).toMatch(/weaker side/i);
  });

  it("is non-destructive — running seedAgents twice does not overwrite the thesis skill", () => {
    seedAgents(dataDir, jobsDb);
    const skillPath = join(
      dataDir,
      ".agents",
      ".library",
      "researcher",
      "skills",
      "thesis.md",
    );
    const first = readFileSync(skillPath, "utf-8");
    seedAgents(dataDir, jobsDb);
    const second = readFileSync(skillPath, "utf-8");
    expect(second).toBe(first);
  });
});
