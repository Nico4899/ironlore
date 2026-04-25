import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, shell } from "electron";

// `__dirname` is provided by esbuild's CJS bundle (the production
// build target) and by Node's CJS loader. Declared explicitly so
// TypeScript — running with `module: ESNext` — accepts it. We
// avoid `import.meta.url` to keep the file CJS-compatible without
// a banner shim.
declare const __dirname: string;

/**
 * Ironlore Electron shell — Phase-10 packaging entry point.
 *
 * docs/07-tech-stack.md §Electron shell is the spec. The shell's
 * job is bundling, OS-native paths, subprocess support, and signed
 * binaries. The actual product (Hono API + React SPA) is unchanged
 * — Electron just wraps it in a desktop window.
 *
 * Architecture (this file):
 *   1. Resolve install root from `app.getPath("userData")` so user
 *      data lands in the OS-native location.
 *   2. Pick an ephemeral loopback port via Node's net module.
 *   3. Spawn the bundled Hono server as a child process with
 *      `IRONLORE_INSTALL_ROOT` + `IRONLORE_PORT` set, plus
 *      `IRONLORE_SERVE_STATIC` pointed at the bundled Vite build
 *      so the SPA + API ride one origin.
 *   4. Poll `/ready` until 200, then load the BrowserWindow at
 *      that URL.
 *   5. On window close, SIGTERM the server child.
 *
 * The spec calls for an in-process server (no fork) — that's a
 * follow-up; spawning matches the existing fresh-install e2e
 * pattern and keeps the Electron main process free of all the
 * server's native-module loading edge cases on first launch.
 */

interface AppPaths {
  /** OS-native user-data root: `~/Library/Application Support/Ironlore` etc. */
  userData: string;
  /** Where the Hono install lives — `<userData>/ironlore`. */
  installRoot: string;
  /** Bundled Vite SPA build directory. */
  staticDir: string;
  /** Bundled Hono server entry. */
  serverEntry: string;
  /** Node binary to spawn the server with. In production we use
   *  Electron's bundled Node (`process.execPath` with the
   *  `ELECTRON_RUN_AS_NODE` env var) so the user doesn't need a
   *  separate Node install. */
  nodeBinary: string;
}

function resolvePaths(): AppPaths {
  const userData = app.getPath("userData");
  const installRoot = join(userData, "ironlore");
  mkdirSync(installRoot, { recursive: true });

  // In dev (`pnpm dev`), the bundled main lives at
  // `apps/electron/dist/main.cjs` and the server source is at
  // `apps/web/src/server/index.ts`. In production (packaged app),
  // both are under `Resources/app.asar.unpacked/...`.
  const isPackaged = app.isPackaged;
  const staticDir = isPackaged
    ? join(process.resourcesPath, "client")
    : resolve(__dirname, "../../../apps/web/dist/client");
  const serverEntry = isPackaged
    ? join(process.resourcesPath, "server", "index.cjs")
    : resolve(__dirname, "../../../apps/web/src/server/index.ts");

  return {
    userData,
    installRoot,
    staticDir,
    serverEntry,
    nodeBinary: process.execPath,
  };
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveFn(port));
      } else {
        rejectFn(new Error("ephemeral port: address resolution failed"));
      }
    });
  });
}

async function pollReady(url: string, timeoutMs: number): Promise<void> {
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
  throw new Error(`Server at ${url} not ready in ${timeoutMs}ms: ${String(lastErr)}`);
}

let serverProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

function spawnServer(paths: AppPaths, port: number): ChildProcess {
  // In dev, the server is TypeScript source — we spawn `tsx` which
  // ships in the workspace `node_modules`. In production the
  // server is bundled to a single .cjs and Electron's own runtime
  // (process.execPath + ELECTRON_RUN_AS_NODE) executes it.
  const isPackaged = app.isPackaged;
  let command: string;
  let args: string[];
  if (isPackaged) {
    command = paths.nodeBinary;
    args = [paths.serverEntry];
  } else {
    const tsx = resolve(__dirname, "../../../node_modules/.bin/tsx");
    if (!existsSync(tsx)) {
      throw new Error(
        `tsx not found at ${tsx}. Run \`pnpm install\` in the workspace root before \`electron\` dev.`,
      );
    }
    command = tsx;
    args = [paths.serverEntry];
  }

  // The bundled server's `external` list keeps native deps
  // (better-sqlite3, sharp, node-pty, @node-rs/argon2) outside the
  // bundle. Production resolution finds them via NODE_PATH pointing
  // at the asar-unpacked node_modules — that's where electron-builder
  // lands the four `asarUnpack` patterns.
  const unpackedModules = isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "node_modules")
    : null;
  const proc = spawn(command, args, {
    env: {
      ...process.env,
      IRONLORE_INSTALL_ROOT: paths.installRoot,
      IRONLORE_PORT: String(port),
      IRONLORE_BIND: "127.0.0.1",
      IRONLORE_SERVE_STATIC: paths.staticDir,
      // Electron's runtime needs ELECTRON_RUN_AS_NODE=1 to act as
      // plain Node when invoked with a script path. Production-only;
      // tsx in dev runs under the workspace's Node and ignores it.
      ...(isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      ...(unpackedModules ? { NODE_PATH: unpackedModules } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[server] ${chunk.toString()}`);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk.toString()}`);
  });
  proc.on("exit", (code) => {
    console.warn(`[server] exited with code ${code ?? "null"}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        "Ironlore server stopped",
        `The Ironlore server exited unexpectedly (code ${code ?? "null"}). Check the log and restart.`,
      );
    }
  });

  return proc;
}

/**
 * On a fresh install the bootstrap script writes the generated
 * admin password to `<installRoot>/.ironlore-install.json` and
 * prints it to stdout. GUI-only users never see stdout, so on
 * first launch we surface the password in a native dialog and
 * pre-copy it to the clipboard. The install record is consumed by
 * the first /api/auth/login call, so this dialog only appears
 * once per new install.
 *
 * Reading the file from the Electron main process (instead of
 * adding a backdoor endpoint) keeps the password out of the HTTP
 * surface — the renderer never has to be trusted with it.
 */
function showFirstRunPasswordDialog(installRoot: string): void {
  const installJsonPath = join(installRoot, ".ironlore-install.json");
  if (!existsSync(installJsonPath)) return;
  let record: { admin_username?: string; initial_password?: string };
  try {
    record = JSON.parse(readFileSync(installJsonPath, "utf-8")) as {
      admin_username?: string;
      initial_password?: string;
    };
  } catch {
    return;
  }
  const password = record.initial_password;
  const username = record.admin_username ?? "admin";
  if (!password) return;

  clipboard.writeText(password);
  dialog.showMessageBoxSync({
    type: "info",
    title: "Ironlore — first run",
    message: "Initial admin password",
    detail:
      `Username: ${username}\nPassword: ${password}\n\n` +
      "The password has been copied to your clipboard. Paste it on the " +
      "login screen, then pick a new one — this initial password will " +
      "not be shown again.",
    buttons: ["Continue"],
    defaultId: 0,
    noLink: true,
  });
}

async function createWindow(paths: AppPaths): Promise<void> {
  const port = await findEphemeralPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  serverProc = spawnServer(paths, port);
  await pollReady(baseUrl, 30_000);
  // Once the server has booted, the install record is on disk if
  // this is a fresh install. Surface it before the BrowserWindow
  // opens so the user lands on the login screen with the password
  // already in their clipboard.
  showFirstRunPasswordDialog(paths.installRoot);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 768,
    minHeight: 480,
    title: "Ironlore",
    webPreferences: {
      // No nodeIntegration in the renderer — the SPA is plain web
      // and talks to the server only via `fetch` + WebSocket.
      // Hardens us against renderer-side compromise reaching the
      // local install root.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Open external links in the user's default browser, not in a
  // child Electron window — keeps the renderer surface bounded.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(baseUrl);
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(async () => {
  try {
    const paths = resolvePaths();
    await createWindow(paths);
  } catch (err) {
    dialog.showErrorBox(
      "Ironlore failed to start",
      err instanceof Error ? err.message : String(err),
    );
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  // SIGTERM the server before exiting so its WAL flushes.
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
  }
});
