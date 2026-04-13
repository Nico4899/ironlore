# Ironlore

Self-hosted AI-native knowledge base. Monorepo with pnpm workspaces.

## Architecture

```
apps/web        Vite + React SPA (client) + Hono API server (server)
apps/worker     Background job daemon (placeholder)
apps/electron   Electron packaging target (placeholder)
packages/core   Shared types, constants, schemas, utilities
packages/cli    CLI entry point (ironlore reindex / migrate / repair)
packages/create-ironlore  Scaffolding CLI
```

- **Client**: `apps/web/src/client/` — React 19, Zustand stores, ProseMirror editor, CodeMirror source view
- **Server**: `apps/web/src/server/` — Hono API, StorageWriter (SQLite WAL + git), auth, search index
- **Core**: `packages/core/src/` — shared between client and server; no Node-only imports in `index.ts` (use `server.ts` for Node APIs like etag, resolve-safe)

## Commands

```sh
pnpm test          # Vitest — all unit/integration tests
pnpm typecheck     # tsc -b (project references)
pnpm check         # Biome lint + format check
pnpm check:fix     # Biome auto-fix
pnpm dev           # Vite dev server (port 5173, proxies /api to 3000)
```

To run the API server in dev: `cd apps/web && npx tsx watch src/server/index.ts`

## Code conventions

- **TypeScript strict** with `noUncheckedIndexedAccess` — use `?? fallback` instead of `!` assertions
- **Biome** for lint and format (not ESLint/Prettier). Run `pnpm check` before committing
- **No direct `child_process`** — use `spawnSafe()` from `spawn-safe.ts` (lint rule enforced)
- **No direct `fetch`/`axios`/`node:https`** in server code — use `fetchForProject()` from `fetch-for-project.ts` (lint rule enforced)
- **No `dangerouslySetInnerHTML`** — enforced by biome at error level. Single exception: `MarkdownPreview.tsx` (biome override scoped to that file), which always uses `renderMarkdownSafe()`
- **Sensitive files** (SQLite DBs with credentials, tokens, salts) must be created with `SENSITIVE_FILE_MODE` (0600). See `permissions.ts` for the list
- **OKLCh colors** — all colors are `oklch()` CSS custom properties. Never use hex values. See `globals.css` and `docs/09-ui-and-brand.md`
- **UI strings** live in `packages/core/src/messages.ts` — no hardcoded user-facing text in components
- **Inter** for UI text, **JetBrains Mono** for code. No font below 12px
- **Lucide** icons only, no emoji in system chrome

## Key patterns

- **Editor block IDs**: Server assigns `<!-- #blk_ULID -->` comments. Editor strips before ProseMirror, reinjects after serialization. Never remove block IDs from markdown
- **ETag concurrency**: All page writes use `If-Match` headers. 409 = conflict, show ConflictBanner
- **Auto-save**: 500ms debounce via `AUTOSAVE_DEBOUNCE_MS` constant from core
- **Zustand stores**: `useAppStore`, `useEditorStore`, `useTreeStore`, `useAIPanelStore` — interfaces defined in `docs/09-ui-and-brand.md`
- **Sanitization**: All rendered markdown goes through `renderMarkdownSafe()` — one function, one code path, `ironloreSchema` allow-list

## Testing

- Tests live next to source files (`*.test.ts`)
- Server tests use real SQLite + temp directories, not mocks
- Roundtrip fidelity: 200+ corpus snippets must survive `parse(serialize(parse(md))) === parse(md)` and 50-cycle stability
- Path traversal: 200 crafted inputs, none escape `resolveSafe()`
- Concurrent writes: 1000 writes to same path produce consistent state

## Project structure for data

```
projects/main/
  data/           Markdown pages (the user's KB)
  .ironlore/      Derived state (index.sqlite, links.sqlite, api-keys.enc)
  .git/           Per-project git repo
```

The server's `process.cwd()` is the install root. `StorageWriter` resolves paths under `projects/<id>/data/` with symlink traversal protection via `resolveSafe()`.

## Design docs

Detailed specs live in `docs/` (not committed to git — in .gitignore):
- `03-editor.md` — editor architecture, sanitization, auto-save, wiki-links
- `05-jobs-and-security.md` — auth, IPC, spawn safety, egress
- `06-implementation-roadmap.md` — phased delivery plan
- `09-ui-and-brand.md` — layout, colors, typography, store shapes, accessibility
