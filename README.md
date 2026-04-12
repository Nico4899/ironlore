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

On first run, an admin password is generated and printed to stdout. Save it — it won't be shown again. The credentials are written to `.ironlore-install.json` (mode 0600) and consumed on first login.

## Project structure

```
ironlore/
├── apps/
│   ├── web/              Vite + React SPA + Hono API server
│   ├── worker/           Jobs daemon (stub — ships in Phase 4)
│   └── electron/         Desktop shell (placeholder — ships in Phase 5)
├── packages/
│   ├── core/             Shared types, schemas, constants, utilities
│   ├── cli/              `ironlore` CLI (reindex, migrate, repair, backup, restore)
│   └── create-ironlore/  `npx create-ironlore` project scaffolder
├── projects/
│   └── main/             Default project (data lives here)
│       ├── project.yaml  Project config (kind, egress policy)
│       └── data/         Knowledge base content (seeded on first run)
└── fixtures/
    └── kb/               Test fixture pages
```

## Architecture

See the [docs/](docs/) directory for the full design:

| Doc | Topic |
|-----|-------|
| 00 | Design principles |
| 01 | Content model (pages, frontmatter, block IDs, page types) |
| 02 | Storage and sync (StorageWriter, WAL, ETags, git) |
| 03 | Editor (ProseMirror, markdown-native, conflict UI) |
| 04 | AI and agents (provider interface, structured tools, memory) |
| 05 | Jobs and security (durable queue, auth, egress, sandboxing) |
| 06 | Implementation roadmap (7 phases) |
| 07 | Tech stack (choices and rationale) |
| 08 | Projects and isolation (the lethal-trifecta fix) |
| 09 | UI and brand (layout, color system, stores, a11y) |

## Tech stack

TypeScript (strict) · Node.js 22 · pnpm workspaces · Vite + React · Hono · Tailwind + shadcn/ui · ProseMirror · CodeMirror 6 · SQLite (better-sqlite3, FTS5) · simple-git · Zustand · TanStack Query · Zod · Argon2id · Vitest + Playwright · Biome

## License

[Apache-2.0](LICENSE)
