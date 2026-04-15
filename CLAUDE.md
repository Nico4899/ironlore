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

- **Client**: `apps/web/src/client/` — React 19, Zustand stores, ProseMirror editor, CodeMirror source view, file type viewers
- **Server**: `apps/web/src/server/` — Hono API, StorageWriter (SQLite WAL + git), auth, search index, file watcher
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
- **No `dangerouslySetInnerHTML`** — enforced by biome at error level. Overrides scoped to `MarkdownPreview.tsx` (uses `renderMarkdownSafe()`) and `MediaViewer.tsx` (a11y caption rule)
- **Sensitive files** (SQLite DBs with credentials, tokens, salts) must be created with `SENSITIVE_FILE_MODE` (0600). See `permissions.ts` for the list
- **OKLCh colors** — all colors are `oklch()` CSS custom properties. Never use hex values. See `globals.css` and `docs/09-ui-and-brand.md`
- **UI strings** live in `packages/core/src/messages.ts` — no hardcoded user-facing text in components
- **Inter** for UI text, **JetBrains Mono** for code. No font below 12px
- **Lucide** icons only, no emoji in system chrome

## Content model and file types

The content model supports 13 page types, detected by file extension via `detectPageType()` in `packages/core/src/page-type.ts`:

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

Word/Excel/Email are ingest-only containers. Viewers and server-side
FTS5 ingestion share a single extractor module at
`packages/core/src/extractors/` (`extract(format, buffer)` dispatcher +
per-format implementations). Dynamic imports keep heavy libraries off
the critical path.

Key helpers in `packages/core/src/page-type.ts`:
- `detectPageType(filePath)` — returns `PageType` from extension
- `isSupportedExtension(filename)` — true if extension maps to a known type (for tree walks, file watcher)
- `isBinaryExtension(filename)` — true for binary types (PDF, image, video, audio, docx, xlsx)

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

`StorageWriter` provides `read()` (UTF-8 string) and `readRaw()` (Buffer) methods. Path traversal protection via `resolveSafe()` on all endpoints.

## Client architecture

- **ContentArea** (`apps/web/src/client/components/ContentArea.tsx`) — central dispatch hub. Reads `fileType` from `useEditorStore`, loads content via the correct API (`fetchPage` for markdown, `fetchRaw` for text types, URL-only for binary types), renders the appropriate viewer component.

- **Viewer components** (`apps/web/src/client/components/viewers/`):
  - `CsvViewer` — editable table with papaparse, double-click-to-edit cells
  - `ImageViewer` — CSS transform zoom
  - `MediaViewer` — shared video/audio with HTML5 controls
  - `MermaidViewer` — DOMParser SVG injection (sanitized), diagram/source toggle
  - `PdfViewer` — PDF.js canvas-per-page, zoom controls
  - `SourceCodeViewer` — read-only CodeMirror with language detection (also drives the `text` type)
  - `TranscriptViewer` — parses `.vtt` / `.srt` into a timestamp + caption table
  - `DocxViewer` — lazy, runs `extract("word", buf)`, sanitizes HTML via `sanitizeHtml()` in `apps/web/src/client/lib/sanitize-html.ts`
  - `XlsxViewer` — lazy, runs `extract("excel", buf)`, tabbed sheet grid
  - `EmailViewer` — lazy, runs `extract("email", buf)`, header block + text body

- **Sidebar** (`apps/web/src/client/components/Sidebar.tsx`) — tree navigation with file-type-specific Lucide icons per `PageType`

- **Client API** (`apps/web/src/client/lib/api.ts`):
  - `fetchPage()` / `savePage()` — markdown JSON API
  - `fetchRawUrl()` — returns URL string for `<img>`/`<video>`/`<audio>` src attributes
  - `fetchRaw()` — returns `Response` for text viewers (source, CSV, mermaid, text, transcript, email)
  - `saveCsv()` — PUT raw text to `/raw/*`

- **Stores** — `useEditorStore` has `fileType: PageType | null` field. `setFile(path, content, etag, fileType)` sets all fields atomically.

## Key patterns

- **Editor block IDs**: Server assigns `<!-- #blk_ULID -->` comments. Editor strips before ProseMirror, reinjects after serialization. Never remove block IDs from markdown
- **ETag concurrency**: All page writes use `If-Match` headers. 409 = conflict, show ConflictBanner. Works for both markdown and CSV
- **Auto-save**: 500ms debounce via `AUTOSAVE_DEBOUNCE_MS` constant from core. Supports markdown and CSV. Captures `filePath`/`fileType` at debounce-trigger time to prevent cross-file race conditions
- **File watcher**: `FileWatcher` detects external edits (VS Code, vim) using chokidar (dev) or `fs.watch` (prod). Handles all supported file types. Binary files store `null` content in WAL (only for git tracking)
- **Zustand stores**: `useAppStore`, `useEditorStore`, `useTreeStore`, `useAIPanelStore` — interfaces defined in `docs/09-ui-and-brand.md`
- **Sanitization**: Rendered markdown → `renderMarkdownSafe()`. Mermaid SVG → DOMParser + strip `<script>`/`<foreignObject>`/`<use>`. No raw HTML injection paths
- **Lazy loading**: PdfViewer and MermaidViewer use `React.lazy()` to code-split heavy dependencies (pdfjs-dist, mermaid)

## Testing

- Tests live next to source files (`*.test.ts`)
- Server tests use real SQLite + temp directories, not mocks
- Roundtrip fidelity: 200+ corpus snippets must survive `parse(serialize(parse(md))) === parse(md)` and 50-cycle stability
- Path traversal: 200 crafted inputs, none escape `resolveSafe()`
- Concurrent writes: 1000 writes to same path produce consistent state
- `readRaw()` tested for binary reads, ENOENT, and path traversal rejection

## Project structure for data

```
projects/main/
  data/           Content files (markdown, CSV, images, code, etc.)
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
