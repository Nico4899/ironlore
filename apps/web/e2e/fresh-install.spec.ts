import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Phase-5 exit criterion — fresh install → working AI panel in <2 min.
 *
 * Walks the actual UI: login with the bootstrapped admin password,
 * forced change-password, the five-step onboarding wizard, and
 * finally a mounted `AIPanelRail` (the "panel is ready" signal — it
 * always renders inside `AppShell`, regardless of whether the panel
 * is open or collapsed).
 *
 * Wall-clock budget is 60 s, well under the documented 2 min: a
 * human's 2 min is dominated by typing API keys + reading copy, and
 * the automated path skips both. A blown budget here means the
 * server-side path got measurably slower, not that the UX target
 * shifted.
 *
 * **Test plumbing.** The Hono API server in `src/server/index.ts`
 * doesn't serve the React SPA — Vite does, in dev. So this spec
 * spawns _both_ on isolated ports:
 *   - Hono on `FRESH_PORT` with `IRONLORE_INSTALL_ROOT` pointed at
 *     a temp dir, so its bootstrap writes to throwaway storage.
 *   - Vite dev server on `VITE_PORT` with `IRONLORE_PROXY_TARGET`
 *     pointed at our isolated Hono — overrides the default `:3000`
 *     proxy in [`vite.config.ts`](../vite.config.ts).
 * Playwright then drives the Vite port; everything is independent
 * of the project's regular dev servers.
 *
 * `webServer` in [`playwright.config.ts`](../playwright.config.ts)
 * still spawns the project's dev API server on 3000 for
 * `health.spec.ts` — this spec doesn't touch it.
 */

const FRESH_PORT = 3007;
const VITE_PORT = 5176;
const FRESH_BASE = `http://127.0.0.1:${FRESH_PORT}`;
const VITE_BASE = `http://127.0.0.1:${VITE_PORT}`;
const READY_TIMEOUT_MS = 45_000;
// Total budget from `page.goto("/")` to `AIPanelRail` visible.
// 60 s is generous for an automated walk; 2 min is the spec ceiling.
const PANEL_READY_BUDGET_MS = 60_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_WEB_DIR = resolve(__dirname, "..");
const SERVER_ENTRY = resolve(APP_WEB_DIR, "src/server/index.ts");
const TSX_BIN = resolve(APP_WEB_DIR, "node_modules/.bin/tsx");
const VITE_BIN = resolve(APP_WEB_DIR, "node_modules/.bin/vite");

let serverProcess: ChildProcess | null = null;
let viteProcess: ChildProcess | null = null;
let installRoot = "";

async function pollHttpUntilReady(
  url: string,
  expectedStatusOk: boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (expectedStatusOk ? res.ok : res.status > 0) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`URL ${url} never became ready within ${timeoutMs}ms: ${String(lastErr)}`);
}

function readAdminPassword(root: string): string {
  const json = readFileSync(resolve(root, ".ironlore-install.json"), "utf-8");
  const parsed = JSON.parse(json) as { initial_password?: string };
  if (!parsed.initial_password) {
    throw new Error(".ironlore-install.json missing initial_password");
  }
  return parsed.initial_password;
}

test.describe("fresh install — onboarding to AI panel", () => {
  // Bootstrap of an isolated Hono install root + a fresh Vite dev
  // server isn't fast enough for Playwright's 30 s default hook
  // timeout. 2 min covers cold seeding on slower laptops.
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    installRoot = mkdtempSync(resolve(tmpdir(), "ironlore-fresh-"));

    // 1. Hono API server in an isolated install root.
    serverProcess = spawn(TSX_BIN, [SERVER_ENTRY], {
      cwd: APP_WEB_DIR,
      env: {
        ...process.env,
        IRONLORE_INSTALL_ROOT: installRoot,
        IRONLORE_PORT: String(FRESH_PORT),
        IRONLORE_BIND: "127.0.0.1",
        IRONLORE_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[fresh-install hono] ${chunk.toString()}`);
    });
    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[fresh-install hono] ${chunk.toString()}`);
    });
    await pollHttpUntilReady(`${FRESH_BASE}/ready`, true, READY_TIMEOUT_MS);

    // 2. Vite dev server proxying to our isolated Hono.
    viteProcess = spawn(
      VITE_BIN,
      ["--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"],
      {
        cwd: APP_WEB_DIR,
        env: {
          ...process.env,
          IRONLORE_PROXY_TARGET: FRESH_BASE,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    viteProcess.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[fresh-install vite] ${chunk.toString()}`);
    });
    viteProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[fresh-install vite] ${chunk.toString()}`);
    });
    // Vite's dev index doesn't expose a /ready, but a 200/404 on the
    // root means the server has bound.
    await pollHttpUntilReady(`${VITE_BASE}/`, false, READY_TIMEOUT_MS);
  });

  test.afterAll(async () => {
    for (const proc of [viteProcess, serverProcess]) {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (!proc.killed) proc.kill("SIGKILL");
      }
    }
    if (installRoot) {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  test("login → change password → onboarding → AI panel mounts within budget", async ({ page }) => {
    test.setTimeout(PANEL_READY_BUDGET_MS + 30_000); // budget + jitter

    const adminPassword = readAdminPassword(installRoot);
    const newPassword = "Replacement-1234567890"; // 22 chars, satisfies the >=12 rule

    const startedAt = Date.now();

    await page.goto(`${VITE_BASE}/`);

    // ── 1. Login ───────────────────────────────────────────────────
    // LoginPage renders <input id="login-password"> autofocused.
    await page.locator("#login-password").fill(adminPassword);
    await page.keyboard.press("Enter");

    // ── 2. Forced change-password ──────────────────────────────────
    await page.locator("#current-password").fill(adminPassword);
    await page.locator("#new-password").fill(newPassword);
    await page.locator("#confirm-password").fill(newPassword);
    // Submit by clicking the visible button — labelled "Set password"
    // per `messages.authChangePasswordButton`. Enter from the
    // confirm field also works but the button click avoids a
    // browser-specific autofill race.
    await page.getByRole("button", { name: /set password/i }).click();

    // ── 3. Onboarding wizard (5 steps) ─────────────────────────────
    // Step 0 Welcome → "Begin"
    await page.getByRole("button", { name: /^Begin/ }).click();
    // Step 1 Scope → "Continue" with default (no checkbox click;
    // wizard's resolvedScopes default keeps the agent rail non-empty).
    await page.getByRole("button", { name: /^Continue/ }).click();
    // Step 2 Agents → "Accept" or "Accept both" depending on the
    // suggestion count. Match by leading "Accept" so either label
    // works.
    await page.getByRole("button", { name: /^Accept/ }).click();
    // Step 3 Seed → "Skip — I'll add docs later" (avoids any file
    // picker / Notion side-effect).
    await page.getByRole("button", { name: /Skip/i }).click();
    // Step 4 Witness → "Open workspace" (calls onComplete →
    // markOnboarded → AppShell renders).
    await page.getByRole("button", { name: /Open workspace/i }).click();

    // ── 4. AI panel ready ──────────────────────────────────────────
    // AIPanelRail mounts inside AppShell unconditionally — its
    // presence proves the post-onboarding shell is live. The full
    // panel itself is collapsed by default; opening it would add
    // user steps without strengthening the criterion.
    const panelRail = page.getByRole("complementary", { name: "AI panel (collapsed)" });
    await expect(panelRail).toBeVisible({ timeout: PANEL_READY_BUDGET_MS });

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs, "fresh install → AI panel exceeded the 2-min budget").toBeLessThan(
      PANEL_READY_BUDGET_MS,
    );
    // Print the timing as a quasi-benchmark — useful when watching
    // for regressions over time. Playwright surfaces console logs
    // in the report.
    console.log(`[fresh-install] AI panel ready in ${elapsedMs}ms`);
  });
});
