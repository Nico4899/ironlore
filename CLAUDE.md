# Ironlore

Self-hosted AI-native knowledge base. Monorepo with pnpm workspaces.

## Architecture

```
apps/web        Vite + React SPA (client) + Hono API server (server)
apps/worker     Background job daemon (placeholder)
apps/electron   Electron packaging target (placeholder)
packages/core   Shared types, constants, schemas, utilities
packages/cli    CLI entry point (ironlore reindex / flush / migrate / repair / backup / restore / eval)
packages/create-ironlore  Scaffolding CLI
```

- **Client**: `apps/web/src/client/` — React 19, Zustand stores, ProseMirror editor, CodeMirror source view, file type viewers
- **Server**: `apps/web/src/server/` — Hono API, StorageWriter (SQLite WAL + git), auth, search index, file watcher, agent engine (jobs, providers, tools, executor)
- **Core**: `packages/core/src/` — shared between client and server; no Node-only imports in `index.ts` (use `server.ts` for Node APIs like etag, resolve-safe). Includes `extractors/` for Word/Excel/Email/Notebook content extraction

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
- **No `dangerouslySetInnerHTML`** — enforced by biome at error level. Overrides scoped to `MarkdownPreview.tsx` (uses `renderMarkdownSafe()`) and `MediaViewer.tsx` (a11y caption rule)
- **Sensitive files** (SQLite DBs with credentials, tokens, salts) must be created with `SENSITIVE_FILE_MODE` (0600). See `permissions.ts` for the list
- **OKLCh colors** — all colors are `oklch()` CSS custom properties. Never use hex values. See `globals.css` and `docs/09-ui-and-brand.md`
- **UI strings** live in `packages/core/src/messages.ts` — no hardcoded user-facing text in components
- **Inter** for UI text, **JetBrains Mono** for code. No font below 12px
- **Lucide** icons only, no emoji in system chrome

## Content model and file types

The content model supports 14 page types, detected by file extension via `detectPageType()` in `packages/core/src/page-type.ts`:

- **markdown** (`.md`) — primary content type, editable via ProseMirror/CodeMirror
- **csv** (`.csv`) — editable spreadsheet table, auto-saves via `PUT /raw/*`
- **pdf** (`.pdf`) — PDF.js canvas renderer (lazy-loaded via `React.lazy`)
- **image** (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`) — zoomable viewer
- **video** (`.mp4`, `.webm`, `.mov`) — HTML5 player
- **audio** (`.mp3`, `.wav`, `.m4a`, `.ogg`) — HTML5 player
- **source-code** (`.ts`, `.js`, `.py`, `.go`, `.rs`, + 20 more) — read-only CodeMirror
- **mermaid** (`.mermaid`, `.mmd`) — diagram renderer (lazy-loaded via `React.lazy`)
- **text** (`.txt`, `.log`) — read-only CodeMirror, no language highlighting
- **transcript** (`.vtt`, `.srt`) — timestamp + caption table, parsed client-side
- **word** (`.docx`) — mammoth → sanitized HTML (lazy-loaded)
- **excel** (`.xlsx`) — SheetJS tabbed grid (lazy-loaded, 500-row render cap)
- **email** (`.eml`) — postal-mime → header block + text body (lazy-loaded)
- **notebook** (`.ipynb`) — Jupyter notebook cells: markdown + code + outputs (lazy-loaded)

Word/Excel/Email/Notebook are ingest-only containers. Viewers and server-side
FTS5 ingestion share a single extractor module at
`packages/core/src/extractors/` (`extract(format, buffer)` dispatcher +
per-format implementations). Dynamic imports keep heavy libraries off
the critical path.

Key helpers in `packages/core/src/page-type.ts`:
- `detectPageType(filePath)` — returns `PageType` from extension
- `isSupportedExtension(filename)` — true if extension maps to a known type (for tree walks, file watcher)
- `isBinaryExtension(filename)` — true for binary types (PDF, image, video, audio, docx, xlsx)
- `extractableFormat(filename)` — returns `"word" | "excel" | "email" | "notebook" | null` for files that need an extractor before FTS5 indexing

## Server API

Two Hono sub-apps handle file I/O:

- **`/api/projects/:id/pages/*`** — markdown JSON API
  - `GET /pages` — tree listing with `PageType | "directory"` per entry
  - `GET /pages/*` — returns `{ content, etag, blocks }` (markdown only)
  - `PUT /pages/*` — write markdown with `If-Match` ETag, assigns block IDs
  - `DELETE /pages/*` — delete with `If-Match` ETag

- **`/api/projects/:id/raw/*`** — raw binary/text serving
  - `GET /raw/*` — raw bytes with correct `Content-Type` (all file types)
  - `PUT /raw/*` — raw text write (CSV only)

- **`/api/projects/:id/search`** — FTS5 search (page-level + chunk-level, RRF merge)

- **`/api/agents/:slug/run`** — agent API
  - `POST /run` — start interactive or autonomous agent run (creates a job)
  - `GET /state` — agent status (active/paused/exhausted), failure streak, rate limits
  - `PATCH /state` — manual pause/resume
  - `GET /job/:jobId` — job status + metadata
  - `GET /job/:jobId/events` — durable event stream (tool calls, text, errors)

- **WebSocket** (`/ws`) — real-time event push (tree changes, search reindex, job events). Ring buffer (1024 events), `?since=N` replay on reconnect, `resync` frame on buffer overflow.

- **`/api/health`** / **`/api/ready`** — health check endpoints

`StorageWriter` provides `read()` (UTF-8 string), `readRaw()` (Buffer), and `moveDir()` (directory rename) methods. Path traversal protection via `resolveSafe()` on all endpoints.

## Client architecture

- **ContentArea** (`apps/web/src/client/components/ContentArea.tsx`) — central dispatch hub. Reads `fileType` from `useEditorStore`, loads content via the correct API (`fetchPage` for markdown, `fetchRaw` for text types, URL-only for binary types), renders the appropriate viewer component.

- **Viewer components** (`apps/web/src/client/components/viewers/`):
  - `CsvViewer` — editable table with papaparse, double-click-to-edit cells
  - `ImageViewer` — CSS transform zoom
  - `MediaViewer` — shared video/audio with HTML5 controls
  - `MermaidViewer` — DOMParser SVG injection (sanitized), diagram/source toggle
  - `PdfViewer` — PDF.js canvas-per-page, zoom controls, text-layer overlay for selection
  - `SourceCodeViewer` — read-only CodeMirror with ~30 language grammars (async loaded via `@codemirror/legacy-modes`). Also drives the `text` type
  - `TranscriptViewer` — parses `.vtt` / `.srt` into a timestamp + caption table with copy-on-hover
  - `DocxViewer` — lazy, runs `extract("word", buf)`, sanitizes HTML via `sanitizeHtml()`
  - `XlsxViewer` — lazy, runs `extract("excel", buf)`, tabbed sheet grid
  - `EmailViewer` — lazy, runs `extract("email", buf)`, header block + text body
  - `NotebookViewer` — lazy, runs `extract("notebook", buf)`, markdown + code + output cells

- **Layout and chrome** (`apps/web/src/client/components/`):
  - `Header` — logo, breadcrumb, search, terminal, theme toggle, AI panel toggle, logout
  - `Sidebar` — hierarchical tree via `buildVisibleRows()`, folder-first sort, depth-based indent, drag-to-resize, auto-collapse below 1024px
  - `TabBar` — `disambiguateTabLabels()` for same-name files, active tab blue border
  - `StatusBar` — last-saved timestamp, editor status icons, connection pill (Wifi/WifiOff)
  - `SplitPane` — resizable two-pane with drag handle, localStorage persistence, keyboard support
  - `Logo` — three-circle Venn SVG with Reuleaux triangle fill
  - `SearchDialog` — Cmd+K command palette, FTS5 search, recent pages

- **AI panel** (`apps/web/src/client/components/`):
  - `AIPanel` — empty-state cards, context pills, paperclip, streaming indicator, tool-call cards with collapsible args, journal entries
  - `AIPanelRail` — 32px collapsed stub with Sparkles icon
  - `AgentToast` — slide-in notification toasts with Web Audio synth chime
  - `DiffPreview` — inline diff card for dry-run agent edits
  - `ProvenancePane` — 40% right pane, scroll-to-block with amber flash

- **Auth and onboarding**:
  - `LoginPage` — password authentication
  - `ChangePasswordPage` — forced password change on first login
  - `OnboardingWizard` — 5-question flow with progress bar

- **Status and recovery**:
  - `OfflineBanner` — non-dismissible amber banner, 1.5s grace period, reconnect button
  - `RecoveryBanner` — LifeBuoy icon, affected paths list, "Run lint" button
  - `ConflictBanner` (in `editor/`) — block-level merge UI with per-conflict resolution
  - `ViewerErrorBoundary` — React error boundary for viewer crashes
  - `Terminal` — embedded terminal with `buildSafeEnv()` env scrubbing

- **Editor** (`apps/web/src/client/components/editor/`):
  - `HighlightToolbar` — floating toolbar on text selection: color swatches, erase, comment, Ask AI
  - `SourceEditor` — frontmatter dimming + block-ID dimming decorations

- **Client API** (`apps/web/src/client/lib/api.ts`):
  - `fetchPage()` / `savePage()` — markdown JSON API
  - `fetchRawUrl()` — returns URL string for `<img>`/`<video>`/`<audio>` src attributes
  - `fetchRaw()` — returns `Response` for text viewers (source, CSV, mermaid, text, transcript). `.docx` / `.xlsx` / `.eml` / `.ipynb` viewers fetch their own `ArrayBuffer` from `fetchRawUrl()` since the extractor needs raw bytes
  - `saveCsv()` — PUT raw text to `/raw/*`

- **Hooks** (`apps/web/src/client/hooks/`):
  - `useAutoSave` — 500ms debounce, captures filePath/fileType at trigger time
  - `useAgentSession` — agent session lifecycle: POST run, poll events, map to ConversationMessage
  - `useWebSocket` — reconnect with `?since=N`, resync handler, gap detection
  - `useResponsiveLayout` — auto-collapse sidebar below 1024px
  - `useThemeClass` — mirror theme to `.light` class on `<html>`
  - `useFocusTrap` — Tab/Shift+Tab trap for modals, focus restore on close

- **Stores** (`apps/web/src/client/stores/`):
  - `useAppStore` — sidebar width, theme, global UI state (persisted to localStorage)
  - `useEditorStore` — `fileType: PageType | null`, `lastSavedAt`, `setFile()` sets all fields atomically
  - `useTreeStore` — file tree nodes, expanded state, selected path
  - `useAIPanelStore` — conversation messages, context pills, agent state
  - `useAuthStore` — session state, login/logout

## Key patterns

- **Editor block IDs**: Server assigns `<!-- #blk_ULID -->` comments. Editor strips before ProseMirror, reinjects after serialization. Never remove block IDs from markdown
- **ETag concurrency**: All page writes use `If-Match` headers. 409 = conflict, show ConflictBanner. Works for both markdown and CSV
- **Auto-save**: 500ms debounce via `AUTOSAVE_DEBOUNCE_MS` constant from core. Supports markdown and CSV. Captures `filePath`/`fileType` at debounce-trigger time to prevent cross-file race conditions
- **File watcher**: `FileWatcher` detects external edits (VS Code, vim) using chokidar (dev) or `fs.watch` (prod). Handles all supported file types. Binary files store `null` content in WAL (only for git tracking)
- **Zustand stores**: `useAppStore`, `useEditorStore`, `useTreeStore`, `useAIPanelStore`, `useAuthStore` — interfaces defined in `docs/09-ui-and-brand.md`
- **Sanitization**: Rendered markdown → `renderMarkdownSafe()` (strips frontmatter before rendering). Mermaid SVG → DOMParser + strip `<script>`/`<foreignObject>`/`<use>`. No raw HTML injection paths
- **Lazy loading**: PdfViewer, MermaidViewer, DocxViewer, XlsxViewer, EmailViewer, NotebookViewer use `React.lazy()` to code-split heavy dependencies
- **WebSocket replay**: Server ring buffer (1024 events), client `?since=N` handshake on reconnect, `resync` event triggers full refresh on buffer overflow, `sessionStorage` persistence of `lastSeq`
- **Typed wiki-links**: `[[target | relation]]` optional pipe syntax. Backlinks table has nullable `rel` column. `ALTER TABLE` migration on init for existing databases
- **Block-level merge**: `diffBlocks()` using LCS over block IDs for common/only-local/only-remote/conflict segments. `applyResolutions()` for per-conflict choices in ConflictBanner
- **Chunk-level FTS5**: `pages_chunks_fts` virtual table with ~800-token chunks at block-ID boundaries. RRF merge with page-level results. Block-ID citation in search responses
- **Agent tools**: `kb.search`, `kb.read_page`, `kb.replace_block`, `kb.create_page`, `agent.journal` — dispatched via `ToolDispatcher` with budget caps (100k tokens, 50 tool calls per run)
- **Job queue**: SQLite-backed durable queue (`jobs.sqlite`). `WorkerPool` with atomic claim, lease renewal (10s/30s), adaptive backpressure per provider. Job events streamed via WebSocket
- **Provider abstraction**: `Provider` interface with Anthropic (SSE streaming, prompt caching), Ollama (NDJSON, auto-detect at `localhost:11434`), Claude CLI (spawnSafe + JSONL)

## Testing

- Tests live next to source files (`*.test.ts`)
- Server tests use real SQLite + temp directories, not mocks
- Roundtrip fidelity: 200+ corpus snippets must survive `parse(serialize(parse(md))) === parse(md)` and 50-cycle stability
- Path traversal: 200 crafted inputs, none escape `resolveSafe()`
- Concurrent writes: 1000 writes to same path produce consistent state
- `readRaw()` tested for binary reads, ENOENT, and path traversal rejection
- Tool-protocol Tier 1: 6+ scenarios against real StorageWriter + SearchIndex (stale ETag, hallucinated block ID, ENOENT, happy path, budget exhaustion, unknown tool)
- Tool-protocol Tier 2: scaffold for nightly model-driven eval (stale-ETag recovery, hallucinated-block recovery, budget exhaustion). Gated by `IRONLORE_EVAL=1`
- Worker pool: enqueue/poll, lease renewal, expired-lease recovery, concurrent pick (no double-dispatch)
- Search index: FTS5 page + chunk indexing, backlinks with typed relations, tag extraction, `.eml` content indexing
- Contrast tests: OKLCh → relative luminance → WCAG 2.1 AA ratio verification
- Extractor tests: `.eml` and `.ipynb` content extraction roundtrips

## Project structure for data

```
projects/main/
  data/           Content files (markdown, CSV, images, code, etc.)
  .ironlore/      Derived state (index.sqlite, links.sqlite, api-keys.enc)
  .git/           Per-project git repo
```

The server's `process.cwd()` is the install root. `StorageWriter` resolves paths under `projects/<id>/data/` with symlink traversal protection via `resolveSafe()`.

## Server infrastructure

The server has five sub-modules under `apps/web/src/server/`:

- **`jobs/`** — durable job queue: `schema.ts` (SQLite tables), `worker.ts` (poll loop, lease renewal), `backpressure.ts` (per-provider adaptive concurrency), `ws-bridge.ts` (per-job WebSocket subscriptions)
- **`providers/`** — AI provider abstraction: `anthropic.ts` (SSE streaming, prompt caching), `ollama.ts` (auto-detect, NDJSON), `registry.ts` (per-project provider resolution)
- **`tools/`** — agent tool implementations: `kb-search.ts`, `kb-read-page.ts`, `kb-replace-block.ts`, `kb-create-page.ts`, `agent-journal.ts`, `dispatcher.ts` (budget enforcement, event logging), `tier2-eval.ts`
- **`agents/`** — agent execution: `executor.ts` (orchestration loop), `rails.ts` (auto-pause at 3 failures, rate limits), `interactive-bridge.ts` (async message queue), `inbox.ts` (staging branches), `revert-run.ts`, `mcp-bridge.ts`, `cost-estimate.ts`, `api.ts` (HTTP routes), `seed-agents.ts`
- **`search/`** — `query-expansion.ts` (strong-signal skip + keyword-rewrite LLM expansion), `rerank.ts` (LLM re-ranking with position-aware blending)

## Design docs

Detailed specs live in `docs/` (not committed to git — in .gitignore):
- `00-principles.md` — core design principles
- `01-content-model.md` — page kinds, block IDs, frontmatter, wiki-links, agent filesystem
- `02-storage-and-sync.md` — StorageWriter, WAL, git, FTS5, chunk indexing, lint-as-migration
- `03-editor.md` — editor architecture, sanitization, auto-save, wiki-links
- `04-ai-and-agents.md` — provider interface, kb.* tools, sessions, retrieval pipeline, tool-protocol testing
- `05-jobs-and-security.md` — auth, IPC, spawn safety, egress, durable job queue
- `06-implementation-roadmap.md` — phased delivery plan (Phases 0–6)
- `07-tech-stack.md` — technology choices and rationale
- `08-competitive-landscape.md` — competitive analysis
- `09-ui-and-brand.md` — layout, colors, typography, store shapes, accessibility
