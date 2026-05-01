import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seed } from "./seed.js";

/**
 * Phase-11 Wiki Gardener seeds:
 *   - .agents/.shared/skills/lint.md (workflow skill)
 *   - _index.md + _log.md (convention pages at the vault root)
 *   - wiki-gardener library persona carries a bespoke body naming
 *     the lint skill and both convention pages
 *
 * The seeder is non-destructive: existing files must not be overwritten
 * on repeat runs or when a user already has these paths populated.
 */

function makeTempDataDir(): string {
  const dir = join(tmpdir(), `seed-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("seed() — Phase 11 Wiki Gardener assets", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes the lint.md shared skill with the expected frontmatter", async () => {
    await seed(dataDir);

    const lintPath = join(dataDir, ".agents", ".shared", "skills", "lint.md");
    const content = readFileSync(lintPath, "utf-8");

    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/\nname: Lint\n/);
    expect(content).toMatch(
      /\ndescription: Wiki health check — orphans, stale sources, contradiction flags, coverage gaps, provenance gaps\n/,
    );
    expect(content).toContain("# Lint Skill");
    // All five detectors now ship as real `kb.lint_*` tools — pin
    // every tool call so a future skill rewrite that drops one is
    // caught. The fifth detector (coverage_gaps) shipped alongside
    // the lint:findings WS event wiring.
    expect(content).toContain("Real check.");
    expect(content).toContain("kb.lint_orphans");
    expect(content).toContain("kb.lint_stale_sources");
    expect(content).toContain("kb.lint_contradictions");
    expect(content).toContain("kb.lint_coverage_gaps");
    expect(content).toContain("kb.lint_provenance_gaps");
    // The skill must close by passing `lintReport` on agent.journal —
    // that's what fires the dismissible UI banner. Pin the literal
    // field name so a refactor that renames the field breaks loudly.
    expect(content).toContain("lintReport");
  });

  it("writes _index.md and _log.md at the vault root with kind: wiki", async () => {
    await seed(dataDir);

    const indexPath = join(dataDir, "_index.md");
    const logPath = join(dataDir, "_log.md");

    const indexContent = readFileSync(indexPath, "utf-8");
    const logContent = readFileSync(logPath, "utf-8");

    expect(indexContent).toMatch(/^---\n/);
    expect(indexContent).toMatch(/\ntitle: Vault Index\n/);
    expect(indexContent).toMatch(/\nkind: wiki\n/);

    expect(logContent).toMatch(/^---\n/);
    expect(logContent).toMatch(/\ntitle: Activity Log\n/);
    expect(logContent).toMatch(/\nkind: wiki\n/);
  });

  it("writes the wiki-gardener library persona with a bespoke maintenance body", async () => {
    await seed(dataDir);

    const personaPath = join(dataDir, ".agents", ".library", "wiki-gardener.md");
    const content = readFileSync(personaPath, "utf-8");

    // Frontmatter shared with other library specialists
    expect(content).toMatch(/\nslug: wiki-gardener\n/);
    expect(content).toMatch(/\nactive: false\n/);
    expect(content).toMatch(/\nheartbeat: "0 6 \* \* 0"\n/);
    expect(content).toMatch(/writable_kinds: \[page, wiki\]/);
    // Iter 2: the gardener declares the lint workflow skill so the
    // executor's skill loader picks it up on each run.
    // Wiki-gardener now opts into both shipped workflow skills:
    // `lint` for the periodic health check + `ingest` for the
    // 5-step Make-like compilation pipeline (proposal A.6).
    expect(content).toMatch(/\nskills: \[lint, ingest\]\n/);
    // Sources-not-compilations declaration per Principle 5a — the
    // gardener's synthesis operations read source pages only.
    expect(content).toMatch(/\n {2}readable_kinds: \[source\]\n/);

    // Body declares the Phase-11 dependency surface
    expect(content).toContain("`lint.md`");
    expect(content).toContain("`_log.md`");
    expect(content).toContain("`_index.md`");
    // Must NOT carry the generic {{company_name}} templating the other
    // specialists use — the gardener's role is vault-local.
    expect(content).not.toContain("{{company_name}}");
  });

  it("leaves the technical-writer template on the generic {{company_name}} body", async () => {
    await seed(dataDir);

    // After the library trim, technical-writer is the only template
    //  that still uses the {{company_name}}/{{company_description}}
    //  onboarding-substitution body. wiki-gardener and evolver are
    //  vault-local maintenance roles with their own bodies.
    const writerPath = join(dataDir, ".agents", ".library", "technical-writer.md");
    const content = readFileSync(writerPath, "utf-8");

    expect(content).toContain("{{company_name}}");
    expect(content).toContain("{{company_description}}");
    // Regression guard: generic personas must not pick up the gardener
    // body or its `skills: [lint]` declaration by accident.
    expect(content).not.toContain("lint.md");
    expect(content).not.toMatch(/skills: \[/);
  });

  it("is idempotent — running seed() twice does not modify existing files", async () => {
    await seed(dataDir);

    const lintPath = join(dataDir, ".agents", ".shared", "skills", "lint.md");
    const indexPath = join(dataDir, "_index.md");
    const logPath = join(dataDir, "_log.md");
    const personaPath = join(dataDir, ".agents", ".library", "wiki-gardener.md");

    const first = {
      lint: readFileSync(lintPath, "utf-8"),
      index: readFileSync(indexPath, "utf-8"),
      log: readFileSync(logPath, "utf-8"),
      persona: readFileSync(personaPath, "utf-8"),
    };

    await seed(dataDir);

    expect(readFileSync(lintPath, "utf-8")).toBe(first.lint);
    expect(readFileSync(indexPath, "utf-8")).toBe(first.index);
    expect(readFileSync(logPath, "utf-8")).toBe(first.log);
    expect(readFileSync(personaPath, "utf-8")).toBe(first.persona);
  });

  it("preserves a user's pre-existing _index.md and _log.md", async () => {
    const indexPath = join(dataDir, "_index.md");
    const logPath = join(dataDir, "_log.md");

    // Simulate a user who already has these pages with their own content.
    writeFileSync(indexPath, "custom index\n", "utf-8");
    writeFileSync(logPath, "custom log\n", "utf-8");

    await seed(dataDir);

    expect(readFileSync(indexPath, "utf-8")).toBe("custom index\n");
    expect(readFileSync(logPath, "utf-8")).toBe("custom log\n");
  });
});
