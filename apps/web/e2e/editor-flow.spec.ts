import { expect, test } from "@playwright/test";
import { type FreshInstallServer, startFreshInstallServer } from "./_fixtures/server.js";

/**
 * End-to-end editor save loop — the second non-trivial Playwright
 * spec called for in the audit. Walks: login → forced
 * change-password → click into a seed page in the sidebar → type
 * into the ProseMirror editor → wait for the auto-save debounce →
 * verify the new text persisted by hitting the pages API directly.
 *
 * The reload-and-verify alternative would also work, but a direct
 * API read is faster, deterministic, and proves the same thing
 * (the save reached durable storage). Auth survives via the same
 * cookie jar Playwright is using for the page.
 *
 * Onboarding is intentionally skipped via `localStorage` rather
 * than walked through — the wizard already has its own dedicated
 * spec ([`fresh-install.spec.ts`](./fresh-install.spec.ts)) and
 * re-running it here would add ~600 ms with no extra coverage.
 */

const HONO_PORT = 3008;
const VITE_PORT = 5177;

const ADMIN_NEW_PASSWORD = "EditorFlow-1234567890"; // 22 chars (>=12)

test.describe("editor save round-trip", () => {
  // Bootstrap of an isolated install root + Vite spin-up isn't fast
  // enough for Playwright's 30 s default hook timeout. Same budget
  // shape as fresh-install.spec.ts.
  test.describe.configure({ timeout: 180_000 });

  let server: FreshInstallServer;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    server = await startFreshInstallServer({
      honoPort: HONO_PORT,
      vitePort: VITE_PORT,
      installRootPrefix: "ironlore-editor-",
    });
  });

  test.afterAll(async () => {
    await server?.shutdown();
  });

  test("type into a seed page and the auto-save persists to disk", async ({ page }) => {
    test.setTimeout(90_000);

    // Skip the onboarding wizard before the SPA boots — App.tsx
    // reads `localStorage.ironlore.onboarded` synchronously on
    // first render. addInitScript fires before any client JS.
    await page.addInitScript(() => {
      window.localStorage.setItem("ironlore.onboarded", "1");
    });

    await page.goto(server.baseUrl);

    // ── 1. Login ───────────────────────────────────────────────────
    await page.locator("#login-password").fill(server.adminPassword);
    await page.keyboard.press("Enter");

    // ── 2. Forced change-password ──────────────────────────────────
    await page.locator("#current-password").fill(server.adminPassword);
    await page.locator("#new-password").fill(ADMIN_NEW_PASSWORD);
    await page.locator("#confirm-password").fill(ADMIN_NEW_PASSWORD);
    await page.getByRole("button", { name: /set password/i }).click();

    // ── 3. AppShell mounted (onboarding flag bypasses the wizard) ──
    await expect(page.getByRole("complementary", { name: "AI panel (collapsed)" })).toBeVisible({
      timeout: 30_000,
    });

    // ── 4. Drill into the seed `getting-started/` folder + open
    //      its index page. The sidebar renders each entry as a
    //      `role="button"` row whose accessible name is the item's
    //      filename (no .md extension visible). `getting-started`
    //      first (the directory), then `index.md`. We use
    //      `getByRole` so a className refactor doesn't break the
    //      selector.
    await page.getByRole("button", { name: /^getting-started$/ }).first().click();
    await page.getByRole("button", { name: /^index\.md$/ }).first().click();

    // ── 5. Editor mounts and the seeded content renders ────────────
    const editor = page.locator(".ProseMirror");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await expect(editor).toContainText("Welcome", { timeout: 15_000 });

    // ── 6. Type a unique marker at the end of the document so the
    //      auto-save fires and we can grep the API response for
    //      our exact contribution. ULIDs would be ideal but Date.now
    //      is enough — we just need uniqueness within this test run.
    const marker = `auto-save-marker-${Date.now()}`;
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End"); // jump to doc end
    await page.keyboard.press("End"); // ensure end-of-line
    await page.keyboard.press("Enter");
    await page.keyboard.type(marker);

    // ── 7. Auto-save: 500 ms client-side debounce + a transit
    //      window. We poll the pages API for up to 5 s with a
    //      200 ms cadence — proves the PUT actually landed and
    //      block-ID assignment didn't strip our content.
    const apiPath = `${server.apiUrl}/api/projects/main/pages/getting-started/index.md`;
    const deadline = Date.now() + 5_000;
    let body: { content?: string; etag?: string } = {};
    while (Date.now() < deadline) {
      const res = await page.request.get(apiPath);
      if (res.ok()) {
        body = (await res.json()) as { content?: string; etag?: string };
        if (body.content?.includes(marker)) break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(body.content, `auto-save marker '${marker}' should reach the server`).toContain(marker);
    expect(body.etag, "save should produce a fresh etag").toMatch(/^"sha256-/);
  });
});
