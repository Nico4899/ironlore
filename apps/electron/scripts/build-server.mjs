#!/usr/bin/env node
/**
 * Bundle the Hono API server into a single CJS file for the
 * packaged Electron app.
 *
 * Why bundle: Electron ships a pruned production tree, and resolving
 * 200+ TypeScript source files at runtime would slow first-launch +
 * leak the source tree into the .app. esbuild gives us one CJS file
 * that Electron's main process can spawn under
 * `ELECTRON_RUN_AS_NODE=1`.
 *
 * Native modules stay external. They're packed by electron-builder
 * via `asarUnpack` and resolved at runtime via NODE_PATH set in
 * `apps/electron/src/main.ts` (the spawned server gets pointed at
 * `<resourcesPath>/app.asar.unpacked/node_modules`).
 *
 * Output: `apps/web/dist/server/index.cjs`. The path is referenced
 * by `apps/electron/electron-builder.yml` `extraResources` and by
 * `apps/electron/src/main.ts` `serverEntry`.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const entry = resolve(repoRoot, "apps/web/src/server/index.ts");
const outfile = resolve(repoRoot, "apps/web/dist/server/index.cjs");

/**
 * Native + opaque modules that can't be bundled. Either they ship
 * platform-specific .node binaries (`better-sqlite3`, `sharp`,
 * `node-pty`, `@node-rs/argon2`) or they have dynamic-require
 * patterns that defeat bundling (`hono` works either way; we let
 * it bundle for a leaner runtime).
 *
 * The four native modules MUST appear in
 * `electron-builder.yml#asarUnpack` so they land on the real
 * filesystem at install time.
 */
const external = [
  "better-sqlite3",
  "sharp",
  "node-pty",
  "@node-rs/argon2",
  "@node-rs/argon2-darwin-arm64",
  "@node-rs/argon2-darwin-x64",
  "@node-rs/argon2-linux-x64-gnu",
  "@node-rs/argon2-linux-arm64-gnu",
  "@node-rs/argon2-win32-x64-msvc",
  // sharp's prebuilt native loader pulls these in dynamically.
  "@img/sharp-darwin-arm64",
  "@img/sharp-darwin-x64",
  "@img/sharp-linux-x64",
  "@img/sharp-linux-arm64",
  "@img/sharp-win32-x64",
];

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile,
  external,
  // Hono + js-yaml + ws + the rest can bundle freely. The only
  // thing keeping us out of full-tree-shake is the dynamic
  // `await import` for `@hono/node-server/serve-static` —
  // esbuild handles that fine.
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  // Better-sqlite3's bindings.js does `require(file)` at runtime;
  // the CommonJS shim esbuild emits handles dynamic require.
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

console.log(`✓ server bundled → ${outfile}`);
