import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("fetchForProject", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ironlore-egress-"));
    mkdirSync(projectDir, { recursive: true });
    // Reset module cache so configCache is fresh each test
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string) {
    writeFileSync(join(projectDir, "project.yaml"), yaml, "utf-8");
  }

  async function loadModule() {
    return import("./fetch-for-project.js") as Promise<typeof import("./fetch-for-project.js")>;
  }

  it("allows requests matching the allowlist", async () => {
    writeConfig(`
preset: main
name: Main
egress:
  policy: allowlist
  allowlist:
    - "https://api.anthropic.com"
`);
    const mod = await loadModule();
    const fakeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fakeFetch);

    await mod.fetchForProject(projectDir, "https://api.anthropic.com/v1/messages");

    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("blocks requests not on the allowlist", async () => {
    writeConfig(`
preset: main
name: Main
egress:
  policy: allowlist
  allowlist:
    - "https://api.anthropic.com"
`);
    const mod = await loadModule();

    await expect(mod.fetchForProject(projectDir, "https://evil.example.com/steal")).rejects.toThrow(
      "Egress blocked",
    );
  });

  it("allows all requests with open policy", async () => {
    writeConfig(`
preset: research
name: Research
egress:
  policy: open
`);
    const mod = await loadModule();
    const fakeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fakeFetch);

    await mod.fetchForProject(projectDir, "https://anything.example.com/path");

    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("blocks all requests with blocked policy", async () => {
    writeConfig(`
preset: sandbox
name: Sandbox
egress:
  policy: blocked
`);
    const mod = await loadModule();

    await expect(
      mod.fetchForProject(projectDir, "https://api.anthropic.com/v1/messages"),
    ).rejects.toThrow("Egress blocked");
  });

  it("defaults to allowlist when egress section is omitted", async () => {
    writeConfig(`
preset: main
name: Main
`);
    const mod = await loadModule();

    // No allowlist → nothing is allowed
    await expect(
      mod.fetchForProject(projectDir, "https://api.anthropic.com/v1/messages"),
    ).rejects.toThrow("Egress blocked");
  });

  it("strips protocol from allowlist entries for hostname comparison", async () => {
    writeConfig(`
preset: main
name: Main
egress:
  policy: allowlist
  allowlist:
    - "https://hooks.slack.com"
`);
    const mod = await loadModule();
    const fakeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fakeFetch);

    await mod.fetchForProject(projectDir, "https://hooks.slack.com/services/T00/B00/xxx");

    expect(fakeFetch).toHaveBeenCalledOnce();
  });
});
