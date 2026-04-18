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
pnpm test                                         # unit + integration tests (856 tests)
pnpm test:e2e                                     # e2e tests (Playwright)
pnpm check                                        # lint + format (Biome)
pnpm typecheck                                    # tsc -b
```

## First run

On first start, Ironlore seeds `projects/main/data/` with:

- **Getting Started** — 5 onboarding pages (pages, agents, search, shortcuts)
- **Carousel** — sample files for every viewer type (PDF, CSV, PNG, SVG, Mermaid, TypeScript, plain text, log, VTT transcript, EML email, Jupyter notebook)
- **Default agents** — General (read-only assistant) + Editor (page mutations)
- **Agent library** — 20 specialist templates in `.agents/.library/` (CEO, Product Manager, Technical Writer, Wiki Gardener, etc.)

A random admin password is printed to stdout and written to `.ironlore-install.json` (mode 0600). Save it — it will not be shown again. On first login you must change the password.

## AI providers

Ironlore is BYOK (bring your own key). Configure a provider:

- **Anthropic**: set `ANTHROPIC_API_KEY` before starting the server
- **Ollama**: run Ollama on `localhost:11434` — auto-detected on startup
- **No provider**: the editor, search, terminal, and all viewers work without AI. The AI panel shows a hint until a provider is configured

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
| `IRONLORE_METRICS` | `false` | Enable `/metrics` Prometheus endpoint |
| `ANTHROPIC_API_KEY` | — | Anthropic API key for Claude models |

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
│   └── electron/            Desktop shell (placeholder)
├── packages/
│   ├── core/                Shared types, schemas, extractors
│   ├── cli/                 ironlore CLI (lint, reindex, backup, restore, eval)
│   └── create-ironlore/    npx create-ironlore scaffolder
├── projects/main/           Default project (data/, .ironlore/, .git/)
└── fixtures/kb/             Test fixture pages
```

## Security

- **Auth**: Argon2id + Ed25519 session cookies, server-side revocation
- **Rate limiting**: 5/min on auth, per-agent tool-call caps
- **Path traversal**: `resolveSafe()` with realpath check, fuzz-tested (200 inputs)
- **Egress**: all outbound HTTP via `fetchForProject()` with per-project allowlist
- **Subprocess safety**: `spawnSafe()` with whitelist-only env (Biome rule enforced)
- **File permissions**: sensitive files mode 0600, checked on startup

## Design system

Ironlore ships on a single OKLCh token layer and a three-family typographic triad. Every color is an `--il-*` CSS variable; every animation references one of four `--motion-*` durations (80ms snap, 180ms transit, 1500ms flash, 3200ms ambient pulse). Fonts are self-hosted via `@fontsource/*` — no Google or Adobe CDN at runtime. The full spec is in [docs/09-ui-and-brand.md](docs/09-ui-and-brand.md).

## License

[Apache-2.0](LICENSE)
