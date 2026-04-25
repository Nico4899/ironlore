import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared e2e fixture — spawns an isolated Hono API server + Vite
 * dev server for one Playwright spec, with cleanup hooks. Each spec
 * gets its own install root (temp dir), Hono port, and Vite port,
 * so two specs can run in parallel without colliding.
 *
 * The Hono server in `apps/web/src/server/index.ts` doesn't serve
 * the React SPA — Vite does, in dev. This helper spawns _both_:
 *   - Hono on `honoPort` with `IRONLORE_INSTALL_ROOT` pointed at
 *     the temp dir.
 *   - Vite on `vitePort` with `IRONLORE_PROXY_TARGET` overriding
 *     the default `:3000` proxy in `vite.config.ts`.
 *
 * The default `webServer` in `playwright.config.ts` is irrelevant
 * to specs that use this helper — they manage their own processes.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// _fixtures/ is one level deeper than e2e/, so apps/web is two up.
const APP_WEB_DIR = resolve(__dirname, "../..");
const SERVER_ENTRY = resolve(APP_WEB_DIR, "src/server/index.ts");
const TSX_BIN = resolve(APP_WEB_DIR, "node_modules/.bin/tsx");
const VITE_BIN = resolve(APP_WEB_DIR, "node_modules/.bin/vite");

export interface FreshInstallServer {
  /** Vite dev URL — what `page.goto` should target. */
  baseUrl: string;
  /** Hono API URL — for direct API assertions. */
  apiUrl: string;
  /** Path to the install root — read .ironlore-install.json from here. */
  installRoot: string;
  /** Bootstrapped admin password from `.ironlore-install.json`. */
  adminPassword: string;
  /** Tear down both processes + remove the install root. */
  shutdown: () => Promise<void>;
}

export interface FreshInstallOptions {
  /** Hono port; the spec is responsible for picking a non-colliding value. */
  honoPort: number;
  /** Vite port. */
  vitePort: number;
  /** How long to wait for /ready (default 45 s — slower laptops bootstrap more slowly). */
  readyTimeoutMs?: number;
  /** Install-root prefix in tmpdir (helpful when debugging leaked dirs). */
  installRootPrefix?: string;
}

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

/**
 * Boot an isolated Hono + Vite pair for the duration of one
 * `test.describe`. Call from `test.beforeAll`; await `shutdown()`
 * from `test.afterAll`.
 */
export async function startFreshInstallServer(
  opts: FreshInstallOptions,
): Promise<FreshInstallServer> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 45_000;
  const apiUrl = `http://127.0.0.1:${opts.honoPort}`;
  const baseUrl = `http://127.0.0.1:${opts.vitePort}`;
  const installRoot = mkdtempSync(resolve(tmpdir(), opts.installRootPrefix ?? "ironlore-e2e-"));

  let honoProc: ChildProcess | null = null;
  let viteProc: ChildProcess | null = null;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const proc of [viteProc, honoProc]) {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (!proc.killed) proc.kill("SIGKILL");
      }
    }
    rmSync(installRoot, { recursive: true, force: true });
  };

  try {
    honoProc = spawn(TSX_BIN, [SERVER_ENTRY], {
      cwd: APP_WEB_DIR,
      env: {
        ...process.env,
        IRONLORE_INSTALL_ROOT: installRoot,
        IRONLORE_PORT: String(opts.honoPort),
        IRONLORE_BIND: "127.0.0.1",
        IRONLORE_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    honoProc.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[hono :${opts.honoPort}] ${chunk.toString()}`);
    });
    honoProc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[hono :${opts.honoPort}] ${chunk.toString()}`);
    });
    await pollHttpUntilReady(`${apiUrl}/ready`, true, readyTimeoutMs);

    viteProc = spawn(
      VITE_BIN,
      ["--port", String(opts.vitePort), "--strictPort", "--host", "127.0.0.1"],
      {
        cwd: APP_WEB_DIR,
        env: { ...process.env, IRONLORE_PROXY_TARGET: apiUrl },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    viteProc.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[vite :${opts.vitePort}] ${chunk.toString()}`);
    });
    viteProc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[vite :${opts.vitePort}] ${chunk.toString()}`);
    });
    await pollHttpUntilReady(baseUrl, false, readyTimeoutMs);

    const adminPassword = readAdminPassword(installRoot);
    return { baseUrl, apiUrl, installRoot, adminPassword, shutdown };
  } catch (err) {
    await shutdown();
    throw err;
  }
}
