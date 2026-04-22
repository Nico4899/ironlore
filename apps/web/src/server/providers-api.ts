import { Hono } from "hono";
import { getProviderKey, hasProviderKey, setProviderKey } from "./providers/key-store.js";
import { OllamaProvider } from "./providers/ollama.js";
import type { ProviderRegistry } from "./providers/registry.js";

/**
 * Top-level HTTP routes for LLM provider configuration.
 *
 * Mounted at `/api/providers` (install-global — provider
 * credentials don't vary per project today). Three routes:
 *
 *   GET  /            → list every known provider + status
 *   POST /:name/key   → save or clear an API key
 *   POST /:name/test  → probe the connection with a minimal call
 *
 * The registry itself is reloaded in-place on key save so the
 * change is live without a server restart. Providers that the
 * user has a key for but that didn't auto-detect at boot (e.g.
 * Anthropic, where we require the key) are registered on demand.
 */

/**
 * The static list of providers the UI knows about. The user sees
 * everything in this list, with each entry's status computed
 * against the current registry + key-store.
 */
const KNOWN_PROVIDERS = ["anthropic", "ollama"] as const;
type KnownProviderName = (typeof KNOWN_PROVIDERS)[number];

function isKnown(name: string): name is KnownProviderName {
  return (KNOWN_PROVIDERS as readonly string[]).includes(name);
}

interface ProviderSummary {
  name: string;
  /**
   * Surface status:
   *   · `connected`    — provider is registered + reachable
   *   · `needs-key`    — provider requires a key; none stored yet
   *   · `unreachable`  — key stored but the endpoint didn't respond
   *                      on the most recent probe (or on boot)
   */
  status: "connected" | "needs-key" | "unreachable";
  /** Whether a key is stored on disk for this provider. */
  keyConfigured: boolean;
  /**
   * When the provider exposes a model list (Ollama today), surface
   * it so the client can offer a default-model picker. Empty array
   * means "no models discovered" (Ollama down, or Anthropic which
   * doesn't enumerate publicly).
   */
  models: string[];
}

export function createProvidersApi(options: {
  registry: ProviderRegistry;
  installRoot: string;
}): Hono {
  const { registry, installRoot } = options;
  const api = new Hono();

  api.get("/", async (c) => {
    const summaries: ProviderSummary[] = [];
    for (const name of KNOWN_PROVIDERS) {
      summaries.push(await buildSummary(name, registry, installRoot));
    }
    return c.json({ providers: summaries });
  });

  api.post("/:name/key", async (c) => {
    const name = c.req.param("name") ?? "";
    if (!isKnown(name)) return c.json({ error: "Unknown provider" }, 400);
    const body = await c.req.json<{ apiKey?: string }>();
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    setProviderKey(installRoot, name, apiKey);

    // Re-register on save so the running server picks up the new
    //  key without a restart. Anthropic is the only provider that
    //  gates registration on a key; Ollama stays auto-detected.
    if (name === "anthropic") {
      // The registry's `register` replaces entries by name, so
      //  updating the key is idempotent — no need to deregister
      //  first. Empty key → deregister by skipping the call and
      //  letting the registry go without Anthropic (we can't
      //  un-register cleanly today, but the next test/run will
      //  fail meaningfully).
      if (apiKey) registry.registerAnthropic(apiKey);
    }

    const summary = await buildSummary(name, registry, installRoot);
    return c.json({ ok: true, provider: summary });
  });

  api.post("/:name/test", async (c) => {
    const name = c.req.param("name") ?? "";
    if (!isKnown(name)) return c.json({ error: "Unknown provider" }, 400);
    const result = await probeProvider(name, installRoot);
    return c.json(result);
  });

  return api;
}

/**
 * Compute the human-facing status for a provider. Cheap local
 * checks only — no network I/O. The `POST /:name/test` route is
 * the explicit "really try a round-trip" button.
 */
async function buildSummary(
  name: KnownProviderName,
  registry: ProviderRegistry,
  installRoot: string,
): Promise<ProviderSummary> {
  const keyConfigured = hasProviderKey(installRoot, name);
  const provider = registry.get(name);
  let status: ProviderSummary["status"];
  if (name === "anthropic") {
    status = provider ? "connected" : keyConfigured ? "unreachable" : "needs-key";
  } else {
    // ollama — auto-detected; no key required.
    status = provider ? "connected" : "unreachable";
  }
  const models = name === "ollama" ? registry.getOllamaModels() : [];
  return { name, status, keyConfigured, models };
}

/**
 * Perform a minimal round-trip against the provider to verify the
 * credentials work. Returns a structured result so the client can
 * show either a green tick or the error message verbatim.
 *
 * Anthropic: we hit the `messages` endpoint with a `max_tokens: 1`
 * payload so we don't burn tokens just to verify. Any 2xx = pass.
 *
 * Ollama: `GET /api/tags` — same probe the auto-detect path uses.
 * Doesn't care about a specific model being installed, just that
 * the daemon answers.
 */
async function probeProvider(
  name: KnownProviderName,
  installRoot: string,
): Promise<{ ok: boolean; detail: string }> {
  if (name === "anthropic") {
    const key = getProviderKey(installRoot, name);
    if (!key) return { ok: false, detail: "No API key saved yet." };
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (res.ok) return { ok: true, detail: "Connected." };
      // 4xx is likely a key problem; forward the server's text so
      //  the user can see "invalid x-api-key" vs. rate-limit etc.
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status} — ${body.slice(0, 160)}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
  if (name === "ollama") {
    const probe = await OllamaProvider.detect();
    if (probe) {
      return { ok: true, detail: `Reachable. ${probe.models.length} model(s) available.` };
    }
    return { ok: false, detail: "Ollama did not respond on localhost:11434." };
  }
  // Never reached — `name` is narrowed to KNOWN_PROVIDERS before this call.
  // Kept for the exhaustive-type discipline.
  const _exhaustive: never = name;
  void _exhaustive;
  return { ok: false, detail: "Unknown provider." };
}
