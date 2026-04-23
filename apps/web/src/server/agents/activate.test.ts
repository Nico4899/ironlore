import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJobsDb } from "../jobs/schema.js";
import { activateAgent } from "./activate.js";

/**
 * Activation endpoint: copy a library persona template into the
 * running-agents tree, flip `active: true`, and create the
 * agent_state row. End-to-end on disk + real SQLite.
 */

type JobsDb = ReturnType<typeof openJobsDb>;

function makeFixture(): { dataDir: string; db: JobsDb } {
  const root = join(tmpdir(), `activate-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(root, { recursive: true });
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openJobsDb(join(root, "jobs.sqlite"));
  return { dataDir, db };
}

function writeLibraryFlat(dataDir: string, slug: string, body: string): void {
  const dir = join(dataDir, ".agents", ".library");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body, "utf-8");
}

function writeLibraryDir(dataDir: string, slug: string, body: string): void {
  const dir = join(dataDir, ".agents", ".library", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "persona.md"), body, "utf-8");
}

const TEMPLATE = `---
name: Wiki Gardener
slug: wiki-gardener
active: false
skills: [lint]
---

You are the Wiki Gardener.
`;

describe("activateAgent", () => {
  let dataDir: string;
  let db: JobsDb;

  beforeEach(() => {
    const fx = makeFixture();
    dataDir = fx.dataDir;
    db = fx.db;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    db.close();
  });

  it("copies a flat .library/<slug>.md template and flips active: true", () => {
    writeLibraryFlat(dataDir, "wiki-gardener", TEMPLATE);

    const result = activateAgent(dataDir, db, "main", "wiki-gardener");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const written = readFileSync(result.personaPath, "utf-8");
    expect(written).toContain("active: true");
    expect(written).not.toContain("active: false");
    // Skills declaration and body must survive the copy.
    expect(written).toContain("skills: [lint]");
    expect(written).toContain("You are the Wiki Gardener.");
  });

  it("copies a directory-style .library/<slug>/persona.md template", () => {
    writeLibraryDir(dataDir, "researcher", TEMPLATE.replace("wiki-gardener", "researcher"));

    const result = activateAgent(dataDir, db, "main", "researcher");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(existsSync(result.personaPath)).toBe(true);
    expect(readFileSync(result.personaPath, "utf-8")).toContain("active: true");
  });

  it("creates memory/, sessions/, and skills/ subdirectories", () => {
    writeLibraryFlat(dataDir, "wiki-gardener", TEMPLATE);
    activateAgent(dataDir, db, "main", "wiki-gardener");

    const agentDir = join(dataDir, ".agents", "wiki-gardener");
    expect(existsSync(join(agentDir, "memory"))).toBe(true);
    expect(existsSync(join(agentDir, "sessions"))).toBe(true);
    expect(existsSync(join(agentDir, "skills"))).toBe(true);
  });

  it("creates an agent_state row with status=active", () => {
    writeLibraryFlat(dataDir, "wiki-gardener", TEMPLATE);
    activateAgent(dataDir, db, "main", "wiki-gardener");

    const row = db
      .prepare("SELECT status FROM agent_state WHERE project_id = ? AND slug = ?")
      .get("main", "wiki-gardener") as { status: string } | undefined;
    expect(row?.status).toBe("active");
  });

  it("returns 404 when no library template exists for the slug", () => {
    const result = activateAgent(dataDir, db, "main", "nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe(404);
    // The agent_state row must NOT be created for a failed activation.
    const row = db
      .prepare("SELECT 1 FROM agent_state WHERE project_id = ? AND slug = ?")
      .get("main", "nonexistent");
    expect(row).toBeUndefined();
  });

  it("returns 409 when the agent is already activated", () => {
    writeLibraryFlat(dataDir, "wiki-gardener", TEMPLATE);
    activateAgent(dataDir, db, "main", "wiki-gardener");
    const second = activateAgent(dataDir, db, "main", "wiki-gardener");

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe(409);
  });

  it("does not mutate the source library template", () => {
    writeLibraryFlat(dataDir, "wiki-gardener", TEMPLATE);
    activateAgent(dataDir, db, "main", "wiki-gardener");
    const source = readFileSync(join(dataDir, ".agents", ".library", "wiki-gardener.md"), "utf-8");
    expect(source).toContain("active: false");
    expect(source).not.toContain("active: true");
  });
});
