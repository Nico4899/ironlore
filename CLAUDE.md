# Ironlore

Self-hosted AI-native knowledge base. Monorepo with pnpm workspaces.

## Architecture

```
apps/web        Vite + React SPA (client) + Hono API server (server)
apps/worker     Background job daemon (placeholder)
apps/electron   Electron desktop shell (spawns the Hono server in-process, sandboxed BrowserWindow)
packages/core   Shared types, constants, schemas, extractors
packages/cli    CLI (ironlore lint / reindex / flush / backup / restore / eval / user add / new-project)
packages/create-ironlore  Scaffolding CLI
```

- **Client** (`apps/web/src/client/`): React 19, Zustand stores, ProseMirror editor, CodeMirror source view, 11 file type viewers, AI panel, onboarding wizard
- **Server** (`apps/web/src/server/`): Hono API, StorageWriter (SQLite WAL + git), FTS5 search (page + chunk level), WebSocket events, auth, file watcher, agent engine (jobs, providers, tools, executor)
- **Core** (`packages/core/src/`): shared between client and server. No Node-only imports in `index.ts` (use `server.ts` for etag, resolve-safe). Includes `extractors/` for Word/Excel/Email/Notebook content extraction

## Commands

```sh
pnpm test          # Vitest (1376 tests)
pnpm test:e2e      # Playwright (fresh-install timing, AI panel, multi-user)
pnpm typecheck     # tsc -b
pnpm check         # Biome lint + format
pnpm check:fix     # Biome auto-fix
pnpm dev           # Vite dev server (port 5173)
```

API server in dev: `cd apps/web && npx tsx watch src/server/index.ts`

Single-origin production mode: set `IRONLORE_SERVE_STATIC=1` and the Hono server serves the built SPA from `apps/web/dist/` instead of relying on Vite. Used by Electron + Docker.

## Code conventions

- **TypeScript strict** with `noUncheckedIndexedAccess`
- **Biome** for lint and format (not ESLint/Prettier)
- **No direct `child_process`** — use `spawnSafe()` / `buildSafeEnv()` (Biome rule enforced)
- **No direct `fetch`** in server code — use `fetchForProject()` (Biome rule enforced)
- **No `dangerouslySetInnerHTML`** — Biome error level. Overrides scoped to files using `renderMarkdownSafe()` or `sanitizeHtml()`
- **Sensitive files** created with mode 0600. Server refuses to start if permissions are broader
- **OKLCh colors** — all CSS via `oklch()` custom properties, no hex. `--il-*` tokens at `:root` are the source of truth; Tailwind `--color-*` names alias via `@theme inline`
- **UI strings** in `packages/core/src/messages.ts`, not hardcoded
- **Three-family type stack**, self-hosted via `@fontsource/*` (no Google/Adobe CDN): **Inter** (UI body 400/500/600), **Instrument Serif** (display 400 + italic), **JetBrains Mono** (metadata undercurrent 400). No font below 10.5px per spec
- **Four motion tokens**, zero others: `--motion-snap` 80ms, `--motion-transit` 180ms, `--motion-flash` 1500ms, `--motion-pulse` 3200ms. Every transition/animation references one of these. User override via `html[data-motion="full"|"reduced"|"none"]`
- **Lucide** icons only for actions/objects. **Reuleaux** primitive for every state pip (idle/running/healthy/warn/error/paused/rate); never a plain dot. **Venn** reserved for onboarding + agent detail + empty states
- **No emoji** in system chrome

## File types

14 types detected by `detectPageType()` in `packages/core/src/page-type.ts`. Markdown and CSV are editable; all others are read-only with dedicated viewers. Word/Excel/Email/Notebook use a shared extractor module (`packages/core/src/extractors/`) for both viewing and FTS5 indexing.

## Server API

- **`/api/projects/:id/pages/*`** — markdown CRUD with ETag concurrency. Per-page ACL frontmatter (`acl: { read, write, owner }`) enforced when multi-user mode is active; first PUT stamps the creator as owner
- **`/api/projects/:id/raw/*`** — binary/text file serving + legacy upload (single-file)
- **`/api/projects/:id/uploads`** — Phase-8 multipart upload pipeline (busboy + `processUpload` gates: size cap, extension allow-list, MIME sniff via `file-type`, sharp re-encode for images, quarantine → atomic handoff, collision hex-suffix). Each rejected file returns `{ filename, code, message }`; bad files don't tank the batch
- **`/api/projects/:id/search`** — FTS5 (page + chunk, RRF merge, query expansion, LLM reranking). `?scope=all` fans out across every registered project's `SearchIndex`, position-RRF merges, tags each hit with `projectId`. Powers the ⌘K "all projects" toggle
- **`/api/projects/:id/embeddings/*`** — hybrid retrieval pipeline. `GET /status` reports backfill progress (chunks total / vectorised / model). `POST /backfill` kicks the per-project `EmbeddingWorker` (Ollama or OpenAI), which batch-embeds chunks into `chunk_vectors`. JS cosine in-process; sqlite-vec deferred
- **`/api/projects/:id/agents/*`** — agent runs, state, pause/resume, cost estimate, onboarding. Phase-6 observability: `GET /:slug/runs`, `GET /:slug/histogram`, `GET /:slug/config`. `GET /agents` returns every installed agent's `{ slug, status }`. `GET /agents/library` lists `.agents/.library/` templates; `POST /agents/<slug>/activate` materialises a library agent
- **`/api/projects/:id/jobs/*`** — job status, events (replay from seq), `POST /:id/revert` to undo an autonomous run
- **`/api/projects/:id/inbox`** — staging branch review (approve/reject + per-file decisions). `GET /:entryId/files` returns A/D/M diff stats + delta counts + per-file `decision`. `POST /:entryId/files/decision` with `{ path, decision: "approved"|"rejected"|null }` records the user's choice without touching git. `approveAll` cherry-picks only non-rejected files when any rejection exists (single commit, branch `-D`), falling back to `rejectAll` when everything is rejected
- **`/api/auth/*`** — login, logout, change-password. Multi-user mode (`IRONLORE_MULTI_USER=1`) opens registration via `ironlore user add <name>`; sessions Ed25519-signed; password hashing Argon2id
- **`/mcp`** — JSON-RPC 2.0 over HTTP for the Ironlore-as-MCP-server surface (kb tools exposed to external clients)
- **`/ws`** — WebSocket events (tree changes, agent events). Ring buffer 1024, `?since=N` replay
- **`/ws/terminal`** — embedded PTY terminal
- **`/health`** / **`/ready`** — health checks

## Key patterns

- **Block IDs**: `<!-- #blk_ULID -->` comments. Server assigns, editor preserves through ProseMirror roundtrip
- **Block provenance**: `<page>.blocks.json` sidecars carry per-block `{ id, type, start, end, derived_from?, agent?, compiled_at? }`. `kb.replace_block` / `kb.insert_after` accept `derived_from` and persist it through StorageWriter so the chain back to raw sources is auditable
- **`writable_kinds` gate**: persona frontmatter declares which `kind:` values an agent may mutate (e.g. `[page, wiki]` excludes `source`). Enforced inside the kb mutation tools — a `kind: source` page is immutable to agents missing the scope
- **ETag concurrency**: `If-Match` on all writes. 409 triggers block-level merge UI (LCS over block IDs). ETags are page-level; block-IDs are the addressing primitive *within* a page
- **Auto-save**: 500ms debounce, captures file identity at trigger time to prevent cross-file saves
- **WebSocket**: single multiplexed stream, replay-from-seq on reconnect, `resync` on buffer overflow
- **Chunk FTS5 + hybrid retrieval**: ~800-token chunks at block-ID seams. BM25 (FTS5) + chunk-vector cosine (chunk_vectors table) RRF-merged with page-level, block-ID citations. Embeddings via `OllamaEmbeddingProvider` (local, auto-detected) or OpenAI `text-embedding-3-small`. Per-project `EmbeddingWorker` backfills on a tick loop
- **Agent tools**: `kb.search`, `kb.read_page`, `kb.read_block`, `kb.replace_block`, `kb.insert_after`, `kb.delete_block`, `kb.create_page`, `kb.lint_orphans`, `kb.lint_stale_sources`, `kb.lint_contradictions`, `kb.lint_provenance_gaps`, `kb.semantic_search`, `kb.global_search` (Airlock-only), `agent.journal`, plus `mcp.<server>.<tool>` proxies for external MCP servers. Budget caps (100k tokens, 50 tool calls) enforced by the executor
- **Cross-project search & Airlock**: `kb.global_search` is gated on `IRONLORE_AIRLOCK=true` and triggers a one-way egress downgrade for the rest of the run the moment any foreign-project hit lands in the returned slice. The downgrade is wired through `createAirlockSession(baseFetch)` — wraps `ProjectContext.fetch` so post-downgrade outbound calls throw `EgressDowngradedError` (HTTP 451). Per-run only; not persisted across restarts
- **Job queue**: SQLite `jobs.sqlite`, atomic claim, 10s/30s lease renewal, adaptive backpressure per provider
- **Batch API path**: Anthropic Message Batches surface (`message-batches-2024-09-24` beta header). Eligible runs (opt-in via persona frontmatter `batch: true`) submit a single batch turn for ~50% list-price savings; executor polls the batch handle and resumes once complete. JSONL result stream parsed line-by-line
- **MCP bridge**: external MCP servers configured per project (`project.yaml` `mcp:` block) are spawned by `mcp-client.ts` (stdio or HTTP transport) and their tools surface as `mcp.<server>.<tool>` in the agent's palette. JSON-RPC 2.0, hand-rolled (no SDK). Symlinked `dataRoot` realpath'd before `spawnSafe` so resolveSafe parity holds on macOS
- **Agent observability**: `agent_runs ⨝ jobs ⨝ agent_state` joins power the detail page. Histogram reuses `AgentRails.canEnqueue()`'s sliding-window query so the UI chart and the rate limiter can't disagree about "you're at cap." Persona frontmatter parsed live via `js-yaml` per request (`agents/observability.ts`); `agent_state` is the canonical mirror for rate caps + status
- **Inbox file decisions**: `inbox_entries.file_decisions` JSON column (additive migration via `PRAGMA table_info`) holds per-path `"approved" | "rejected"` markers. UI optimistically toggles; server rollback on error. Partial-approve path uses `git checkout <branch> -- <path>` per non-rejected file + one commit + `branch -D` (entry status becomes `"partial"`)
- **Providers**: Anthropic (SSE + prompt caching + Message Batches), Ollama (auto-detect + NDJSON, both chat and embedding), OpenAI (embeddings). `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` envs or local Ollama
- **Multi-user + ACLs**: opt-in via `IRONLORE_MULTI_USER=1`. `ironlore user add <username>` shells into the same Argon2id+Ed25519 stack as the bootstrap admin. Per-page ACL frontmatter (`acl: { read: [...], write: [...], owner: <user> }`) checked by `assertCanAccess` in `acl.ts`; first PUT stamps the creator as `owner`. ACL regex tolerates trailing block-ID comments inside the frontmatter list
- **Connector skills**: `.agents/.shared/skills/connectors/*.md` recipes for HTTP-fetch + transform patterns (e.g. github-issue-search, http-get-with-auth, webhook-trigger). Plain markdown loaded by `skill-loader.ts`; egress respects per-project allowlist
- **API-key vault** (Phase 8): per-project `projects/<id>/.ironlore/api-keys.enc`, AES-256-GCM under an Argon2id-derived key (19 MiB / 2 iter / 1 parallelism / 32-byte output), versioned JSON envelope. `POST /api/auth/change-password` re-encrypts every project's vault inline; writeVault retains the prior ciphertext as `.enc.bak` for one restart cycle. `VaultKey.dispose()` zeros the buffer after use

## Testing

- Tests next to source (`*.test.ts`), real SQLite + temp dirs, no mocks
- 1376 unit/integration tests in Vitest, 104 files
- 200+ roundtrip corpus snippets with 50-cycle stability
- 200 path-traversal fuzz inputs
- 1000 concurrent writes consistency
- 6 Tier-1 tool-protocol scenarios (stale ETag, hallucinated block ID, ENOENT, budget exhaustion)
- 5000-page sidebar/search benchmark (<400ms / <200ms)
- Phase-8 security corpora: 60 XSS payloads walked through a real DOM (happy-dom) against both `renderMarkdownSafe` and `sanitizeHtml`; 23 allowlist/blocked-policy egress bypass attempts; 26 path-traversal + cross-project escape attempts + 9 benign baseline paths against `resolveSafe`
- Provider-mode smoke tests (no-AI, Ollama, BYOK)
- Playwright e2e: fresh-install → AI panel in <2 min, multi-user login + ACL enforcement, axe-core WCAG 2.1 AA scan, color-contrast against the OKLCh tokens. Fixtures spawn Hono+Vite per test (self-managing)
- Red-team corpus: signature-tampering, cross-project egress bypass, ACL bypass via frontmatter forgery, MCP-tool injection. Documented in `docs/security-review.md`

## Data layout

```
projects/main/
  data/           Content files
  .ironlore/      Derived state (index.sqlite, links.sqlite)
  .git/           Per-project git repo
```

Multi-project is shipped (Phase 9). `bootstrap()` seeds a default `main` project, but `projects.sqlite` (install-root) can hold any number of projects. `ironlore new-project <id> --preset main|research|sandbox` scaffolds the layout + `project.yaml`. Each project owns its own `StorageWriter`, `SearchIndex`, `LinksRegistry`, `GitWorker`, `FileWatcher`, `EmbeddingWorker`, MCP client(s), and API-key vault — bundled in `ProjectServices`. Routes mount per project under `/api/projects/<id>/…`. The `Cmd+P` palette switches active project via `?project=<id>` + full reload. Cross-project copy via right-click → "Copy to project…" stamps `copied_from: <src>/<path>@<sha>` into the destination's frontmatter. The install root is `IRONLORE_INSTALL_ROOT` (default: `./projects`).

## Deployment shapes

- **Dev**: `pnpm dev` (Vite 5173) + `npx tsx watch src/server/index.ts` (Hono 3000) — split origin
- **Single-origin (production)**: `IRONLORE_SERVE_STATIC=1` + `pnpm build` — Hono serves the SPA from `apps/web/dist/`
- **Electron**: `apps/electron/` spawns Hono in-process with `IRONLORE_SERVE_STATIC=1`, polls `/ready`, opens a sandboxed BrowserWindow. `electron-builder` config; native modules (better-sqlite3, sharp) `asarUnpack`'d. Notarization secrets supplied at release time
- **Docker**: `Dockerfile` (multi-stage, Node 22-bookworm-slim, libvips, tini PID 1) + `docker-compose.yml` (port `127.0.0.1:3000:3000`, named volume `ironlore-data` at `/app/projects`). Bind to loopback by default; expose via reverse proxy
