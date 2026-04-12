# ironlore

Self-hosted knowledge base with AI agents that remember everything.

Markdown on disk is the contract. Everything else — editor, sync engine, AI, UI — is a cache or a view. If the app dies tomorrow, `cd data/ && git log` is still a complete experience.

## Prerequisites

- [Node.js](https://nodejs.org/) 22 LTS or later
- [pnpm](https://pnpm.io/) 10+

```sh
# install pnpm if you don't have it
npm install -g pnpm
```

## Setup

```sh
git clone <repo-url> ironlore
cd ironlore
pnpm install
```

## Development

```sh
# start the Vite dev server (proxies API to Hono on :3000)
pnpm dev

# run unit + integration tests
pnpm test

# run tests in watch mode
pnpm test:watch

# run e2e tests (requires Playwright browsers)
pnpm test:e2e

# lint + format check
pnpm check

# auto-fix lint + format issues
pnpm check:fix

# typecheck all packages
pnpm typecheck
```

## First run

On first start, Ironlore generates a random admin password, prints it to stdout, and writes the bootstrap record to `.ironlore-install.json` (mode 0600). Save the password — it will not be shown again.

On first login you will be forced to change the password. The install record is deleted after the change completes; there is no shipped credential to forget to rotate.

## Configuration

All configuration is via environment variables. Unset means "safe default".

| Variable | Default | Description |
|---|---|---|
| `IRONLORE_BIND` | `127.0.0.1` | Listen address. Non-loopback requires `IRONLORE_PUBLIC_URL`. |
| `IRONLORE_PORT` | `3000` | Listen port. |
| `IRONLORE_PUBLIC_URL` | — | Required for non-loopback bind. Must start with `https://`. |
| `IRONLORE_ALLOWED_ORIGINS` | same-origin | Comma-separated CORS origin allowlist. `*` is rejected. |
| `IRONLORE_METRICS` | `false` | Set to `true` to enable the `/metrics` Prometheus endpoint. |

## Project structure

```
ironlore/
├── apps/
│   ├── web/              Vite + React SPA + Hono API server
│   ├── worker/           Jobs daemon (stub — ships in Phase 4)
│   └── electron/         Desktop shell (placeholder — ships in Phase 5)
├── packages/
│   ├── core/             Shared types, schemas, constants, utilities
│   ├── cli/              `ironlore` CLI (reindex, flush, migrate, repair, backup, restore)
│   └── create-ironlore/  `npx create-ironlore` project scaffolder
├── projects/
│   └── main/                 Default project
│       ├── project.yaml      Project config (kind, egress policy)
│       ├── data/             Knowledge base content (seeded on first run)
│       └── .ironlore/        Derived state (never committed to git)
│           ├── index.sqlite  FTS5 search index, backlinks, tags, recent edits
│           ├── wal/          Write-ahead log (crash recovery)
│           └── locks/        Advisory lock files (cross-process mutex)
├── .ironlore-install.json    Bootstrap credentials (deleted after first password change)
├── ipc.token                 Worker ↔ web auth token (rotated every startup)
├── password.salt             Per-instance Argon2id salt
├── sessions.sqlite           Server-side session store
├── projects.sqlite           Project registry
└── fixtures/
    └── kb/                   Test fixture pages
```

Files at the install root (`ipc.token`, `password.salt`, `sessions.sqlite`, `projects.sqlite`, `.ironlore-install.json`) are created with mode 0600. The server refuses to start if any of them have broader permissions.

## Security

Ironlore is designed for single-user self-hosting but treats security as load-bearing, not decorative:

- **Auth**: Argon2id password hashing with per-instance salt. Ed25519-signed session cookies (`Secure`, `HttpOnly`, `SameSite=Lax`) backed by a server-side session table for instant revocation.
- **Rate limiting**: token bucket on auth endpoints (5/min per IP) and agent tool calls (60/min per project+agent).
- **Path traversal**: `resolveSafe()` validates both the logical path and the realpath (symlink resolution). Fuzz-tested with 200 crafted inputs.
- **Egress enforcement**: all outbound HTTP goes through `fetchForProject()`, gated by the project's `egress.policy` in `project.yaml`. A lint rule bans direct `fetch`/`axios`/`node:https` imports.
- **IPC auth**: worker ↔ web routes require loopback origin + a timing-safe token comparison.
- **File permissions**: sensitive files are mode 0600; the server checks on startup and refuses to run if any are too broad.

## License

[Apache-2.0](LICENSE)
