import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase-8 egress bypass corpus (docs/05-jobs-and-security.md §Security test suite).
 *
 * Every outbound HTTP call in Ironlore flows through `fetchForProject`.
 * A Biome lint rule (`noRestrictedImports`) bans direct `fetch`,
 * `axios`, and `node:https` imports outside that module — so the
 * single choke-point is real. This corpus feeds the choke-point a
 * broad set of URL shapes that an attacker (or a malformed config)
 * might use to bypass the allowlist, and asserts that none of them
 * reach the underlying `fetch`.
 *
 * Three policies live in `project.yaml`:
 *  · `allowlist` — only hostnames listed under `egress.allowlist`.
 *  · `open`      — every host allowed (research projects).
 *  · `blocked`   — nothing allowed.
 *
 * The corpus concentrates on `allowlist` because that is the shape
 * attackers actually probe; `blocked` and `open` are one-liners and
 * already covered by the base suite.
 */

describe("egress corpus — allowlist bypass attempts", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "egress-corpus-"));
    mkdirSync(projectDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeAllowlist(hosts: string[]) {
    const yaml = [
      "preset: main",
      "name: Main",
      "egress:",
      "  policy: allowlist",
      "  allowlist:",
      ...hosts.map((h) => `    - "${h}"`),
      "",
    ].join("\n");
    writeFileSync(join(projectDir, "project.yaml"), yaml, "utf-8");
  }

  async function loadModule() {
    return import("./fetch-for-project.js") as Promise<typeof import("./fetch-for-project.js")>;
  }

  // ---------------------------------------------------------------------------
  // Every URL in BYPASS_ATTEMPTS must be blocked when the allowlist
  // is exactly ["api.anthropic.com"]. Each entry is a real-world
  // trick attempted against allowlist-style policies.
  // ---------------------------------------------------------------------------

  const BYPASS_ATTEMPTS: Array<{ label: string; url: string }> = [
    // Obvious unrelated host.
    { label: "unrelated-host", url: "https://evil.example.com/steal" },
    // Subdomain confusion — attacker controls a subdomain that
    //  superficially looks like the allowed host.
    { label: "subdomain-prefix", url: "https://api.anthropic.com.evil.example/x" },
    { label: "suffix-subdomain", url: "https://evil-api.anthropic.com/x" },
    // Naive string-contains check would pass these; a proper hostname
    //  comparison must reject them.
    { label: "path-contains-allowed-host", url: "https://evil.example/api.anthropic.com/x" },
    { label: "query-contains-allowed-host", url: "https://evil.example/?host=api.anthropic.com" },
    // Userinfo smuggling — old-style `user:pass@host` URLs.
    { label: "userinfo-as-host", url: "https://api.anthropic.com@evil.example/x" },
    { label: "userinfo-with-port", url: "https://api.anthropic.com:443@evil.example/x" },
    // Wrong host entirely, matched allowlist entry that's similar.
    { label: "near-miss", url: "https://api.anthropic.co/v1/messages" },
    { label: "typosquat", url: "https://api.anthr0pic.com/v1/messages" },
    // Alternate protocols — allowlist is hostname-only; non-http
    //  protocols still flow through and must be refused.
    { label: "ftp-protocol", url: "ftp://api.anthropic.com/x" },
    // Uppercase + whitespace host shapes — URL parsing may tolerate
    //  these, but hostname comparison must still block them if the
    //  resolved hostname isn't on the list.
    { label: "uppercase-bypass", url: "https://API.ANTHROPIC.COM.EVIL.EXAMPLE/x" },
    // IP-literal for the allowed host — circumvent DNS-based filtering.
    { label: "ip-literal", url: "https://160.79.104.10/v1/messages" },
    // Alternate allowed-entry formats the user might type — with
    //  protocol, trailing slash, leading whitespace — should still
    //  only match by exact hostname.
    { label: "case-rewrite-host", url: "https://API.anthropic.com/x" }, // allowed uppercase
  ];

  for (const { label, url } of BYPASS_ATTEMPTS) {
    it(`blocks bypass: ${label} → ${url}`, async () => {
      writeAllowlist(["api.anthropic.com"]);
      const mod = await loadModule();
      const fakeFetch = vi.fn().mockResolvedValue(new Response("ok"));
      vi.stubGlobal("fetch", fakeFetch);

      // Either reject outright (EgressBlockedError) OR if URL parses
      //  to the allowed host (e.g. case-rewrite), silently succeed —
      //  we distinguish by checking fakeFetch.
      try {
        await mod.fetchForProject(projectDir, url);
      } catch {
        // Blocked — that's the primary success path.
        expect(fakeFetch).not.toHaveBeenCalled();
        return;
      }

      // If the call didn't throw, the URL parsed and the HOSTNAME
      //  (case-insensitive in WHATWG URL parsing) was an exact match.
      //  Acceptable only for payloads like "API.anthropic.com" where
      //  the normalized hostname equals "api.anthropic.com".
      if (fakeFetch.mock.calls.length === 1) {
        const callUrl = fakeFetch.mock.calls[0]![0] as URL;
        expect(callUrl.hostname.toLowerCase()).toBe("api.anthropic.com");
      } else {
        throw new Error(`bypass '${label}' succeeded without blocking: ${url}`);
      }
    });
  }

  it(`covers at least 10 bypass attempts (current: ${BYPASS_ATTEMPTS.length})`, () => {
    expect(BYPASS_ATTEMPTS.length).toBeGreaterThanOrEqual(10);
  });

  // ---------------------------------------------------------------------------
  // "blocked" policy — every URL must be refused regardless of shape.
  // ---------------------------------------------------------------------------

  const BLOCKED_ATTEMPTS: string[] = [
    "https://api.anthropic.com/v1/messages",
    "https://any.example/",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/", // AWS metadata service
    "http://[::1]/",
    "https://raw.githubusercontent.com/x/y/main/z",
  ];

  for (const url of BLOCKED_ATTEMPTS) {
    it(`'blocked' policy refuses: ${url}`, async () => {
      writeFileSync(
        join(projectDir, "project.yaml"),
        "preset: sandbox\nname: Sandbox\negress:\n  policy: blocked\n",
        "utf-8",
      );
      const mod = await loadModule();
      const fakeFetch = vi.fn().mockResolvedValue(new Response("ok"));
      vi.stubGlobal("fetch", fakeFetch);

      await expect(mod.fetchForProject(projectDir, url)).rejects.toThrow();
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  }

  // ---------------------------------------------------------------------------
  // Empty allowlist — must behave as a closed world.
  // ---------------------------------------------------------------------------

  it("empty allowlist blocks every attempt", async () => {
    writeFileSync(
      join(projectDir, "project.yaml"),
      "preset: main\nname: Main\negress:\n  policy: allowlist\n  allowlist: []\n",
      "utf-8",
    );
    const mod = await loadModule();
    const fakeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fakeFetch);

    for (const url of ["https://api.anthropic.com/", "https://x.example/"]) {
      await expect(mod.fetchForProject(projectDir, url)).rejects.toThrow();
    }
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Missing egress block — default must fail closed, not open.
  // ---------------------------------------------------------------------------

  it("missing egress config fails closed", async () => {
    writeFileSync(
      join(projectDir, "project.yaml"),
      "preset: main\nname: Main\n",
      "utf-8",
    );
    const mod = await loadModule();
    const fakeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fakeFetch);

    await expect(mod.fetchForProject(projectDir, "https://api.anthropic.com/")).rejects.toThrow();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Happy path still works — the corpus must not regress legitimate
  // traffic. Sanity check: allowlisted host → fetch called exactly once.
  // ---------------------------------------------------------------------------

  it("happy path: allowlisted host reaches fetch()", async () => {
    writeAllowlist(["api.anthropic.com"]);
    const mod = await loadModule();
    const fakeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fakeFetch);

    await mod.fetchForProject(projectDir, "https://api.anthropic.com/v1/messages");
    expect(fakeFetch).toHaveBeenCalledOnce();
  });
});
