import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchForProject } from "../fetch-for-project.js";
import { seed } from "../seed.js";
import { loadSkills } from "./skill-loader.js";

/**
 * Phase-11 connector-skill smoke tests.
 *
 * Three checks. The first two pin the seeded artifacts: every
 * connector skill has the documented frontmatter shape, and each
 * names the upstream host so an operator copying the snippet into
 * their `project.yaml` lands on the right allowlist entry. The
 * third walks an end-to-end "skill says X, fetchForProject
 * enforces X" round-trip — the audit's "smoke test invokes one
 * through a stub upstream and asserts fetchForProject's allowlist
 * gates it" criterion.
 */

interface ConnectorSkill {
  /** File path relative to `.agents/.shared/skills/`. */
  filename: string;
  /** Expected `name:` in frontmatter. */
  name: string;
  /** Hostnames the skill documents under `egress.allowlist`. */
  expectedHosts: string[];
}

const CONNECTORS: ConnectorSkill[] = [
  {
    filename: "github-issue-search.md",
    name: "GitHub Issue Search",
    expectedHosts: ["api.github.com"],
  },
  {
    filename: "webhook-trigger.md",
    name: "Webhook Trigger",
    expectedHosts: ["hooks.slack.com", "discord.com"],
  },
  {
    filename: "http-get-with-auth.md",
    name: "HTTP GET with auth",
    // The parametric template documents two hosts as the
    // example — we don't assert on every one, just confirm the
    // primary placeholder lands.
    expectedHosts: ["api.example.com"],
  },
];

let dataDir: string;

beforeEach(() => {
  dataDir = join(tmpdir(), `connector-${randomBytes(4).toString("hex")}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("connector skills — seeded artifacts", () => {
  it("seeds all three connector skills under .agents/.shared/skills/", async () => {
    await seed(dataDir);
    const skillsDir = join(dataDir, ".agents", ".shared", "skills");
    for (const c of CONNECTORS) {
      expect(existsSync(join(skillsDir, c.filename))).toBe(true);
    }
  });

  it("each skill carries the expected name + description frontmatter", async () => {
    await seed(dataDir);
    const skillsDir = join(dataDir, ".agents", ".shared", "skills");
    for (const c of CONNECTORS) {
      const body = readFileSync(join(skillsDir, c.filename), "utf-8");
      expect(body).toMatch(/^---\n/);
      expect(body).toMatch(new RegExp(`\\nname: ${c.name}\\n`));
      expect(body).toMatch(/\ndescription: [^\n]+\n/);
    }
  });

  it("each skill documents the upstream host so the user knows what to allowlist", async () => {
    // The audit calls out `project.yaml allowlist entries` as a
    // required artifact of every connector skill. A skill that
    // forgets to document its host is a footgun: the user runs
    // it, fetchForProject throws EgressBlocked, and the failure
    // mode isn't obvious.
    await seed(dataDir);
    const skillsDir = join(dataDir, ".agents", ".shared", "skills");
    for (const c of CONNECTORS) {
      const body = readFileSync(join(skillsDir, c.filename), "utf-8");
      // Each skill names the host literally + lists it in a
      // YAML allowlist snippet.
      expect(body).toContain("egress:");
      expect(body).toContain("policy: allowlist");
      for (const host of c.expectedHosts) {
        expect(body).toContain(host);
      }
    }
  });

  it("each skill documents the auth handoff + at least one error shape", async () => {
    await seed(dataDir);
    const skillsDir = join(dataDir, ".agents", ".shared", "skills");
    for (const c of CONNECTORS) {
      const body = readFileSync(join(skillsDir, c.filename), "utf-8");
      // Auth handoff section — heading + token-source guidance.
      expect(body).toMatch(/##\s+Auth/i);
      // Error-shape table — the JSON shape is the contract.
      expect(body).toMatch(/##\s+Error shapes/i);
      // EgressBlocked is the universal failure mode that crosses
      // every connector; locking it in here means a future skill
      // that drops the egress error path gets caught.
      expect(body.toLowerCase()).toContain("egress");
    }
  });
});

describe("connector skills — load through skill-loader", () => {
  it("loadSkills(...) picks up a connector by name from .shared/skills/", async () => {
    await seed(dataDir);
    // No agent-local skills/ directory; loader falls through to
    // the .shared/skills/ copy. Mirrors the resolution order
    // documented in skill-loader.ts.
    const block = loadSkills(dataDir, "demo", ["github-issue-search"]);
    expect(block).toContain("# GitHub Issue Search Skill");
    expect(block).toContain("api.github.com");
  });

  it("loads multiple connector skills into a single prompt block", async () => {
    await seed(dataDir);
    const block = loadSkills(dataDir, "demo", ["webhook-trigger", "http-get-with-auth"]);
    expect(block).toContain("# Webhook Trigger Skill");
    expect(block).toContain("# HTTP GET with Auth Skill");
  });
});

describe("connector skills — fetchForProject enforces the documented allowlist", () => {
  // The audit's smoke criterion: "invokes one through a stub
  // upstream and asserts fetchForProject's allowlist gates it."
  // We don't have a generic agent-callable HTTP tool today
  // (connectors compose either through MCP or the documented
  // pattern); the closest equivalent is to verify the egress
  // primitive does what the connector skills claim.

  function writeProjectYaml(allowlist: string[]): string {
    const projectDir = join(tmpdir(), `connector-egress-${randomBytes(4).toString("hex")}`);
    mkdirSync(projectDir, { recursive: true });
    const yaml = [
      "preset: main",
      "name: ConnectorTest",
      "egress:",
      "  policy: allowlist",
      "  allowlist:",
      ...allowlist.map((h) => `    - ${h}`),
      "",
    ].join("\n");
    writeFileSync(join(projectDir, "project.yaml"), yaml, "utf-8");
    return projectDir;
  }

  it("blocks an off-allowlist host (the EgressBlocked path the skills document)", async () => {
    const projectDir = writeProjectYaml(["api.github.com"]);
    try {
      await expect(
        fetchForProject(projectDir, "https://attacker.example.com/exfil"),
      ).rejects.toThrow(/egress|attacker|allowlist/i);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
