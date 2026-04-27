import { expect, test } from "@playwright/test";
import { type FreshInstallServer, startFreshInstallServer } from "./_fixtures/server.js";

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
 * Process orchestration (Hono + Vite on isolated ports + a temp
 * install root) lives in [`_fixtures/server.ts`](./_fixtures/server.ts).
 */

const HONO_PORT = 3007;
const VITE_PORT = 5176;
// Total budget from `page.goto("/")` to `AIPanelRail` visible.
// 60 s is generous for an automated walk; 2 min is the spec ceiling.
const PANEL_READY_BUDGET_MS = 60_000;

test.describe("fresh install — onboarding to AI panel", () => {
  // Bootstrap of an isolated Hono install root + a fresh Vite dev
  // server isn't fast enough for Playwright's 30 s default hook
  // timeout. 2 min covers cold seeding on slower laptops.
  test.describe.configure({ timeout: 180_000 });

  let server: FreshInstallServer;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    server = await startFreshInstallServer({
      honoPort: HONO_PORT,
      vitePort: VITE_PORT,
      installRootPrefix: "ironlore-fresh-",
    });
  });

  test.afterAll(async () => {
    await server?.shutdown();
  });

  test("login → change password → onboarding → AI panel mounts within budget", async ({ page }) => {
    test.setTimeout(PANEL_READY_BUDGET_MS + 30_000); // budget + jitter

    const newPassword = "Replacement-1234567890"; // 22 chars, satisfies the >=12 rule

    const startedAt = Date.now();

    await page.goto(`${server.baseUrl}/`);

    // ── 1. Login ───────────────────────────────────────────────────
    // LoginPage renders <input id="login-password"> autofocused.
    await page.locator("#login-password").fill(server.adminPassword);
    await page.keyboard.press("Enter");

    // ── 2. Forced change-password ──────────────────────────────────
    await page.locator("#current-password").fill(server.adminPassword);
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
