# ironlore

Self-hosted knowledge base with AI agents that remember everything.

Markdown on disk is the contract. Everything else — editor, sync engine, AI, UI — is a cache or a view. If the app dies tomorrow, `cd data/ && git log` is still a complete experience.

## Prerequisites

- [Node.js](https://nodejs.org/) 22 LTS or later
- [pnpm](https://pnpm.io/) 10+

## Setup

```sh
git clone <repo-url> ironlore
cd ironlore
pnpm install
```

## Development

```sh
pnpm dev                                          # Vite dev server (port 5173)
cd apps/web && npx tsx watch src/server/index.ts  # API server (port 3000, separate terminal)
pnpm test                                         # unit + integration tests (1376 tests, 104 files)
pnpm test:e2e                                     # e2e tests (Playwright)
pnpm check                                        # lint + format (Biome)
pnpm typecheck                                    # tsc -b
```

## First run

On first start, Ironlore seeds `projects/main/data/` with:

- **Getting Started** — 5 onboarding pages (pages, agents, search, shortcuts)
- **Carousel** — sample files for every viewer type (PDF, CSV, PNG, SVG, Mermaid, TypeScript, plain text, log, VTT transcript, EML email, Jupyter notebook)
- **Default agents** — Librarian (read-only KB assistant) + Editor (page mutations with dry-run + inline diff)
- **Agent library** — three opt-in specialist templates with dedicated tooling: Wiki Gardener (lint detectors), Researcher (thesis-driven investigation), and Evolver (skill-improvement loop). Anything else is one Visual Agent Builder away

A random admin password is printed to stdout and written to `.ironlore-install.json` (mode 0600). Save it — it will not be shown again. On first login you must change the password.

## AI providers

Ironlore is BYOK (bring your own key). Configure a provider:

- **Anthropic**: set `ANTHROPIC_API_KEY` before starting the server. Supports SSE streaming, prompt caching, and the Message Batches API for ~50% list-price savings on opt-in agent runs
- **Ollama**: run Ollama on `localhost:11434` — auto-detected on startup. Provides both chat and embedding models (used by hybrid retrieval if no remote embedding key is set)
- **OpenAI**: set `OPENAI_API_KEY` to use `text-embedding-3-small` for hybrid-retrieval embeddings. Chat models are not currently wired
- **No provider**: the editor, search, terminal, and all viewers work without AI. The AI panel shows a hint until a provider is configured

External MCP servers can be wired per project via `project.yaml` (`mcp:` block); their tools surface as `mcp.<server>.<tool>` in the agent palette. Ironlore also speaks MCP itself at `/mcp` so external clients can call its `kb.*` tools.

## Supported file types

| Type | Extensions | Viewer | Editable |
|---|---|---|---|
| Markdown | `.md` | ProseMirror WYSIWYG + CodeMirror source | Yes |
| CSV | `.csv` | Spreadsheet table | Yes |
| PDF | `.pdf` | PDF.js canvas with text selection | No |
| Image | `.png` `.jpg` `.webp` `.gif` `.svg` | Zoomable viewer | No |
| Video | `.mp4` `.webm` `.mov` | HTML5 player | No |
| Audio | `.mp3` `.wav` `.m4a` `.ogg` | HTML5 player | No |
| Source code | `.ts` `.js` `.py` `.go` `.rs` + 20 more | CodeMirror with syntax highlighting | No |
| Mermaid | `.mermaid` `.mmd` | Diagram renderer | No |
| Plain text | `.txt` `.log` | CodeMirror | No |
| Transcript | `.vtt` `.srt` | Timestamp + caption table with citations | No |
| Word | `.docx` | Mammoth HTML + convert-to-markdown button | No |
| Excel | `.xlsx` | Tabbed grid + convert-to-CSV button | No |
| Email | `.eml` | Header block + text body | No |
| Notebook | `.ipynb` | Jupyter cells (markdown + code + outputs) | No |

Binary files can be uploaded via drag-and-drop onto the content area.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `IRONLORE_BIND` | `127.0.0.1` | Listen address |
| `IRONLORE_PORT` | `3000` | Listen port |
| `IRONLORE_PUBLIC_URL` | — | Required for non-loopback bind (`https://` only) |
| `IRONLORE_ALLOWED_ORIGINS` | same-origin | CORS allowlist (comma-separated, `*` rejected) |
| `IRONLORE_TRUST_NETWORK_BIND` | `false` | Set `1` to bypass loopback-bind validation (Docker / Electron only — never on the public internet) |
| `IRONLORE_INSTALL_ROOT` | `./projects` | Where projects live on disk |
| `IRONLORE_SERVE_STATIC` | `false` | Serve the built SPA from `apps/web/dist/` (single-origin production / Electron / Docker) |
| `IRONLORE_PROXY_TARGET` | — | When set, the dev server proxies API calls here instead of spawning its own |
| `IRONLORE_METRICS` | `false` | Enable `/metrics` Prometheus endpoint |
| `IRONLORE_MULTI_USER` | `false` | Open registration flow + per-page ACL enforcement |
| `IRONLORE_AIRLOCK` | `false` | Register `kb.global_search` (cross-project agent search with one-way egress downgrade) |
| `ANTHROPIC_API_KEY` | — | Anthropic API key for Claude models + Message Batches |
| `OPENAI_API_KEY` | — | OpenAI key for `text-embedding-3-small` (hybrid retrieval) |

## Project structure

```
ironlore/
├── apps/
│   ├── web/                 Vite + React SPA + Hono API server
│   │   └── src/
│   │       ├── client/      React 19 SPA (components, hooks, stores, lib)
│   │       └── server/      Hono API (storage, search, auth, WebSocket,
│   │                        jobs, providers, tools, agents, terminal)
│   ├── worker/              Background job daemon (placeholder)
│   └── electron/            Desktop shell (electron-builder, sandboxed BrowserWindow)
├── packages/
│   ├── core/                Shared types, schemas, extractors
│   ├── cli/                 ironlore CLI (lint, reindex, backup, restore, eval, user add, new-project)
│   └── create-ironlore/    npx create-ironlore scaffolder
├── projects/main/           Default project (data/, .ironlore/, .git/)
├── Dockerfile               Multi-stage Node 22-bookworm-slim image
├── docker-compose.yml       Loopback-bound web service + named volume
└── fixtures/kb/             Test fixture pages
```

## Deployment

- **Development**: split origin (Vite 5173 + Hono 3000)
- **Single-origin (production)**: `IRONLORE_SERVE_STATIC=1 pnpm build && cd apps/web && node dist/server/index.js`
- **Docker**: `docker compose up -d` — bind to `127.0.0.1:3000`, persistent volume `ironlore-data`
- **Electron**: `pnpm --filter @ironlore/electron build && pnpm --filter @ironlore/electron dist` — produces a notarized desktop bundle (notarization secrets supplied at release time)

## Multi-user mode

```sh
IRONLORE_MULTI_USER=1 pnpm dev          # enable user registration + ACLs
pnpm --filter @ironlore/cli ironlore user add <username>
```

Per-page ACLs live in frontmatter (`acl: { read, write, owner }`). The first writer is stamped as owner. Sessions are Ed25519-signed cookies with server-side revocation; passwords are Argon2id.

## Security

- **Auth**: Argon2id + Ed25519 session cookies, server-side revocation
- **Rate limiting**: 5/min on auth, per-agent tool-call caps
- **Path traversal**: `resolveSafe()` with realpath check, fuzz-tested (200 inputs)
- **Egress**: all outbound HTTP via `fetchForProject()` with per-project allowlist (`open | allowlist | offline`)
- **Subprocess safety**: `spawnSafe()` with whitelist-only env (Biome rule enforced)
- **File permissions**: sensitive files mode 0600, checked on startup
- **Per-page ACLs** (multi-user): read/write/owner lists in page frontmatter, enforced server-side
- **Airlock Protocol** (opt-in via `IRONLORE_AIRLOCK=1`): cross-project agent search via `kb.global_search` triggers a one-way egress downgrade. Once a foreign-project block enters the agent's transcript, every outbound HTTP call in the run throws `EgressDowngradedError` (HTTP 451). Per-run, not persisted across restarts
- **Red-team review**: see [docs/security-review.md](docs/security-review.md). Zero findings above informational severity

## Design system

Ironlore ships on a single OKLCh token layer and a three-family typographic triad. Every color is an `--il-*` CSS variable; every animation references one of four `--motion-*` durations (80ms snap, 180ms transit, 1500ms flash, 3200ms ambient pulse). Fonts are self-hosted via `@fontsource/*` — no Google or Adobe CDN at runtime. The full spec is in [docs/09-ui-and-brand.md](docs/09-ui-and-brand.md).

## License

[Apache-2.0](LICENSE)
