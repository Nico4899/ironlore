import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectYaml, newProject } from "./new-project.js";

/**
 * `ironlore new-project` — scaffolds a project directory and writes
 * a preset-appropriate `project.yaml`. Server registration happens on
 * next boot via the ProjectRegistry; this test only asserts the on-
 * disk layout, which is what the CLI is responsible for.
 */

describe("buildProjectYaml", () => {
  it("main preset produces an allowlist policy with provider hosts", () => {
    const yaml = buildProjectYaml({ id: "main", name: "Main", preset: "main" });
    expect(yaml).toContain("id: main");
    expect(yaml).toContain("preset: main");
    expect(yaml).toContain("policy: allowlist");
    expect(yaml).toContain("api.anthropic.com");
  });

  it("research preset uses open policy and empty accept_promotions_from", () => {
    const yaml = buildProjectYaml({ id: "r1", name: "Research", preset: "research" });
    expect(yaml).toContain("policy: open");
    expect(yaml).toContain("accept_promotions_from: []");
  });

  it("sandbox preset uses blocked policy", () => {
    const yaml = buildProjectYaml({ id: "s1", name: "Scratch", preset: "sandbox" });
    expect(yaml).toContain("policy: blocked");
  });

  it("quotes a name that contains characters YAML would misinterpret", () => {
    const yaml = buildProjectYaml({ id: "x", name: "Name: with colon", preset: "sandbox" });
    expect(yaml).toContain('name: "Name: with colon"');
  });
});

describe("newProject (fs scaffolding)", () => {
  let cwd: string;
  let original: string;
  const logs: string[] = [];
  const errs: string[] = [];

  beforeEach(() => {
    cwd = join(tmpdir(), `new-project-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(cwd, { recursive: true });
    original = process.cwd();
    process.chdir(cwd);
    logs.length = 0;
    errs.length = 0;
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
  });

  afterEach(() => {
    process.chdir(original);
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks();
  });

  it("creates the full directory layout + project.yaml", () => {
    newProject("alpha", { preset: "main" });
    const projectDir = join(cwd, "projects", "alpha");
    expect(existsSync(join(projectDir, "data"))).toBe(true);
    expect(existsSync(join(projectDir, ".ironlore"))).toBe(true);
    expect(existsSync(join(projectDir, ".ironlore", "locks"))).toBe(true);
    expect(existsSync(join(projectDir, ".ironlore", "wal"))).toBe(true);
    const yaml = readFileSync(join(projectDir, "project.yaml"), "utf-8");
    expect(yaml).toContain("id: alpha");
    expect(yaml).toContain("preset: main");
  });

  it("honors --name and --preset options", () => {
    newProject("beta", { name: "Beta Research", preset: "research" });
    const yaml = readFileSync(join(cwd, "projects", "beta", "project.yaml"), "utf-8");
    // Plain YAML strings with safe characters pass through unquoted.
    expect(yaml).toContain("name: Beta Research");
    expect(yaml).toContain("policy: open");
  });

  it("refuses to overwrite an existing project directory", () => {
    const existing = join(cwd, "projects", "gamma");
    mkdirSync(existing, { recursive: true });
    const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    expect(() => newProject("gamma", { preset: "main" })).toThrow(/exit:1/);
    expect(errs.some((m) => m.includes("already exists"))).toBe(true);
    spy.mockRestore();
  });

  it("rejects ids that aren't filesystem-safe", () => {
    const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    expect(() => newProject("../evil", { preset: "main" })).toThrow(/exit:2/);
    spy.mockRestore();
  });

  it("rejects invalid preset", () => {
    const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    expect(() => newProject("delta", { preset: "bogus" as "main" })).toThrow(/exit:2/);
    spy.mockRestore();
  });
});
