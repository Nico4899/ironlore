# @ironlore/electron

Electron shell for Ironlore. Wraps the Hono server + Vite SPA into
a desktop app with OS-native data paths.

Spec: [docs/07-tech-stack.md §Electron shell](../../docs/07-tech-stack.md).

## Local dev

```sh
pnpm install            # at the workspace root
pnpm --filter @ironlore/web build:client
pnpm --filter @ironlore/electron dev
```

The dev script:

1. Bundles `apps/electron/src/main.ts` → `dist/main.cjs` via esbuild.
2. Spawns Electron pointed at `dist/main.cjs`.
3. Electron main resolves `app.getPath("userData")` → install root,
   picks an ephemeral loopback port, spawns the Hono server with
   `IRONLORE_INSTALL_ROOT`, `IRONLORE_PORT`, and
   `IRONLORE_SERVE_STATIC=<bundled SPA>` set.
4. Once `/ready` returns 200, opens a `BrowserWindow` at the bound
   URL.

User data lands in the OS-native location:

- macOS: `~/Library/Application Support/Ironlore/ironlore`
- Linux: `~/.config/Ironlore/ironlore`
- Windows: `%APPDATA%/Ironlore/ironlore`

## Production build (unsigned)

```sh
pnpm --filter @ironlore/electron dist:mac
```

Produces `out/Ironlore-<version>.dmg` and a `.zip` artifact.
Without code-signing certs, the DMG installs an unsigned app —
the user has to right-click → Open the first time to bypass
Gatekeeper.

## Production build (signed + notarized)

Requires Apple Developer ID and notarization credentials. Set the
following env vars before `pnpm dist:mac`:

| Variable | Source |
|---|---|
| `CSC_LINK` | base64-encoded `.p12` Developer ID Application cert bundle |
| `CSC_KEY_PASSWORD` | password for the `.p12` |
| `APPLE_ID` | Apple ID with Developer Program access |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-character team ID from the Apple Developer portal |

In CI, store these as encrypted secrets and inject them into the
job that runs `pnpm dist:mac`. electron-builder picks them up
automatically — no extra configuration required.

Windows code-signing uses the same `CSC_LINK` + `CSC_KEY_PASSWORD`
shape with a Windows EV cert.

## Native modules + asar

The Hono server spawned by the Electron main process loads four
native modules: `better-sqlite3`, `node-pty`, `sharp`, and
`@node-rs/argon2`. asar can't execute compiled binaries, so all
four are listed in `electron-builder.yml`'s `asarUnpack` so they
land on the real filesystem. The Vite SPA build + bundled server
ride as `extraResources`.

## What's left

The "Done when" criterion in the roadmap audit asks for a notarized,
code-signed `.app` produced by a single command. The packaging
machinery is in place; the missing piece is the actual signing
identity, which only the project owner can supply (Apple won't
issue Developer ID certificates to anonymous build pipelines).

Other follow-ups:

- In-process server (no fork) per spec point 1. Today's spawn-based
  approach is simpler and matches the existing fresh-install e2e
  pattern; the in-process variant requires refactoring
  `apps/web/src/server/index.ts` into a callable export.
- `electron-updater` auto-update wiring per spec point 5.
- `--headless` CLI mode that runs against the same data root per
  spec point 6.
