import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Phase-5 exit criterion — fresh install → working AI panel in <2 min.
 *
 * Walks the actual UI: a self-spawned server on an isolated install
 * root, login with the bootstrapped admin password, forced
 * change-password, the five-step onboarding wizard, and finally a
 * mounted `AIPanelRail` (the "panel is ready" signal — it always
 * renders inside `AppShell`, regardless of whether the panel is
 * open or collapsed).
 *
 * Wall-clock budget is 60 s, well under the documented 2 min: a
 * human's 2 min is dominated by typing API keys + reading copy, and
 * the automated path skips both. A blown budget here means the
 * server-side path got measurably slower, not that the UX target
 * shifted.
 *
 * `webServer` in [`playwright.config.ts`](../playwright.config.ts)
 * still spawns the project's dev server on 3000 for `health.spec.ts`
 * — this spec is independent and runs against a separate process on
 * 3007 with `IRONLORE_INSTALL_ROOT` pointing at a temp directory.
 */

const FRESH_PORT = 3007;
const FRESH_BASE = `http://127.0.0.1:${FRESH_PORT}`;
const READY_TIMEOUT_MS = 30_000;
// Total budget from `page.goto("/")` to `AIPanelRail` visible.
// 60 s is generous for an automated walk; 2 min is the spec ceiling.
const PANEL_READY_BUDGET_MS = 60_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_WEB_DIR = resolve(__dirname, "..");
const SERVER_ENTRY = resolve(APP_WEB_DIR, "src/server/index.ts");
const TSX_BIN = resolve(APP_WEB_DIR, "node_modules/.bin/tsx");

let serverProcess: ChildProcess | null = null;
let installRoot = "";

async function pollUntilReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/ready`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server at ${url} never became ready within ${timeoutMs}ms: ${String(lastErr)}`);
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
  test.beforeAll(async () => {
    installRoot = mkdtempSync(resolve(tmpdir(), "ironlore-fresh-"));

    serverProcess = spawn(TSX_BIN, [SERVER_ENTRY], {
      cwd: APP_WEB_DIR,
      env: {
        ...process.env,
        IRONLORE_INSTALL_ROOT: installRoot,
        IRONLORE_PORT: String(FRESH_PORT),
        IRONLORE_BIND: "127.0.0.1",
        // Suppress the metrics endpoint conflict on shared dev box.
        IRONLORE_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Surface server stderr if startup fails — invaluable when the
    // CI log is the only thing the developer can see.
    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[fresh-install server] ${chunk.toString()}`);
    });

    await pollUntilReady(FRESH_BASE, READY_TIMEOUT_MS);
  });

  test.afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      // Give the process a moment to exit cleanly; if it doesn't,
      // SIGKILL on the way out so test runs don't leak.
      await new Promise((r) => setTimeout(r, 500));
      if (!serverProcess.killed) serverProcess.kill("SIGKILL");
    }
    if (installRoot) {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  test("login → change password → onboarding → AI panel mounts within budget", async ({
    page,
  }) => {
    test.setTimeout(PANEL_READY_BUDGET_MS + 30_000); // budget + jitter

    const adminPassword = readAdminPassword(installRoot);
    const newPassword = "Replacement-1234567890"; // 22 chars, satisfies the >=12 rule

    const startedAt = Date.now();

    await page.goto(`${FRESH_BASE}/`);

    // ── 1. Login ───────────────────────────────────────────────────
    // LoginPage renders <input id="login-password"> autofocused.
    await page.fill("#login-password", adminPassword);
    await page.keyboard.press("Enter");

    // ── 2. Forced change-password ──────────────────────────────────
    await page.fill("#current-password", adminPassword);
    await page.fill("#new-password", newPassword);
    await page.fill("#confirm-password", newPassword);
    // Submit by clicking the visible button — Enter from the
    // confirm field also works but the button click avoids a
    // browser-specific autofill race.
    await page.getByRole("button", { name: /change password/i }).click();

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
