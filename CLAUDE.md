# Ironlore

Self-hosted AI-native knowledge base. Monorepo with pnpm workspaces.

## Architecture

```
apps/web        Vite + React SPA (client) + Hono API server (server)
apps/worker     Background job daemon (placeholder)
apps/electron   Electron packaging target (placeholder)
packages/core   Shared types, constants, schemas, extractors
packages/cli    CLI (ironlore lint / reindex / flush / backup / restore / eval)
packages/create-ironlore  Scaffolding CLI
```

- **Client** (`apps/web/src/client/`): React 19, Zustand stores, ProseMirror editor, CodeMirror source view, 11 file type viewers, AI panel, onboarding wizard
- **Server** (`apps/web/src/server/`): Hono API, StorageWriter (SQLite WAL + git), FTS5 search (page + chunk level), WebSocket events, auth, file watcher, agent engine (jobs, providers, tools, executor)
- **Core** (`packages/core/src/`): shared between client and server. No Node-only imports in `index.ts` (use `server.ts` for etag, resolve-safe). Includes `extractors/` for Word/Excel/Email/Notebook content extraction

## Commands

```sh
pnpm test          # Vitest (572 tests)
pnpm typecheck     # tsc -b
pnpm check         # Biome lint + format
pnpm check:fix     # Biome auto-fix
pnpm dev           # Vite dev server (port 5173)
```

API server in dev: `cd apps/web && npx tsx watch src/server/index.ts`

## Code conventions

- **TypeScript strict** with `noUncheckedIndexedAccess`
- **Biome** for lint and format (not ESLint/Prettier)
- **No direct `child_process`** — use `spawnSafe()` / `buildSafeEnv()` (Biome rule enforced)
- **No direct `fetch`** in server code — use `fetchForProject()` (Biome rule enforced)
- **No `dangerouslySetInnerHTML`** — Biome error level. Overrides scoped to files using `renderMarkdownSafe()` or `sanitizeHtml()`
- **Sensitive files** created with mode 0600. Server refuses to start if permissions are broader
- **OKLCh colors** — all CSS via `oklch()` custom properties, no hex
- **UI strings** in `packages/core/src/messages.ts`, not hardcoded
- **Inter** for UI, **JetBrains Mono** for code. No font below 12px
- **Lucide** icons only, no emoji in system chrome

## File types

14 types detected by `detectPageType()` in `packages/core/src/page-type.ts`. Markdown and CSV are editable; all others are read-only with dedicated viewers. Word/Excel/Email/Notebook use a shared extractor module (`packages/core/src/extractors/`) for both viewing and FTS5 indexing.

## Server API

- **`/api/projects/:id/pages/*`** — markdown CRUD with ETag concurrency
- **`/api/projects/:id/raw/*`** — binary/text file serving + upload
- **`/api/projects/:id/search`** — FTS5 (page + chunk, RRF merge, query expansion, LLM reranking)
- **`/api/projects/:id/agents/*`** — agent runs, state, pause/resume, cost estimate, onboarding
- **`/api/projects/:id/jobs/*`** — job status, events (replay from seq), revert
- **`/api/projects/:id/inbox`** — staging branch review (approve/reject)
- **`/ws`** — WebSocket events (tree changes, agent events). Ring buffer 1024, `?since=N` replay
- **`/ws/terminal`** — embedded PTY terminal
- **`/health`** / **`/ready`** — health checks

## Key patterns

- **Block IDs**: `<!-- #blk_ULID -->` comments. Server assigns, editor preserves through ProseMirror roundtrip
- **ETag concurrency**: `If-Match` on all writes. 409 triggers block-level merge UI (LCS over block IDs)
- **Auto-save**: 500ms debounce, captures file identity at trigger time to prevent cross-file saves
- **WebSocket**: single multiplexed stream, replay-from-seq on reconnect, `resync` on buffer overflow
- **Chunk FTS5**: ~800-token chunks at block-ID seams, RRF merge with page-level, block-ID citations
- **Agent tools**: `kb.search`, `kb.read_page`, `kb.replace_block`, `kb.create_page`, `agent.journal` with budget caps (100k tokens, 50 tool calls)
- **Job queue**: SQLite `jobs.sqlite`, atomic claim, 10s/30s lease renewal, adaptive backpressure per provider
- **Providers**: Anthropic (SSE + prompt caching), Ollama (auto-detect + NDJSON). `ANTHROPIC_API_KEY` env or local Ollama

## Testing

- Tests next to source (`*.test.ts`), real SQLite + temp dirs, no mocks
- 200+ roundtrip corpus snippets with 50-cycle stability
- 200 path-traversal fuzz inputs
- 1000 concurrent writes consistency
- 6 Tier-1 tool-protocol scenarios (stale ETag, hallucinated block ID, ENOENT, budget exhaustion)
- 5000-page sidebar/search benchmark (<400ms / <200ms)
- Provider-mode smoke tests (no-AI, Ollama, BYOK)

## Data layout

```
projects/main/
  data/           Content files
  .ironlore/      Derived state (index.sqlite, links.sqlite)
  .git/           Per-project git repo
```

`DEFAULT_PROJECT_ID = "main"` hardcoded until Phase 5 multi-project.
