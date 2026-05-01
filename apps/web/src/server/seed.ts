import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { AGENTS_DIR, AGENTS_LIBRARY_DIR, AGENTS_SHARED_DIR, ulid } from "@ironlore/core";

/**
 * Write a file only if it doesn't already exist. Non-destructive seeding.
 */
function seedFile(filePath: string, content: string): void {
  if (existsSync(filePath)) return;
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}

/**
 * Seed the data directory on first run.
 *
 * Creates a `getting-started/` folder of onboarding pages, a `carousel/`
 * folder showcasing every core viewer type, and the `.agents/` tree
 * (default General + Editor, specialist library, shared skills). Skips
 * any file that already exists.
 */
export async function seed(dataDir: string): Promise<void> {
  const now = new Date().toISOString();

  // -------------------------------------------------------------------------
  // Getting Started — how to use Ironlore
  // -------------------------------------------------------------------------
  seedFile(
    join(dataDir, "getting-started", "index.md"),
    `---
schema: 1
id: ${ulid()}
title: Getting Started
kind: page
created: ${now}
modified: ${now}
tags: [onboarding]
icon: lucide:rocket
---

# Getting Started with Ironlore

Welcome. Ironlore is a self-hosted knowledge base where plain markdown on
disk is the contract. The editor, search index, and AI agents are all caches
or views over files you own. If the app stops running tomorrow, your data is
still a git repository you can \`cd\` into.

AI agents are first-class teammates here, not a chat overlay. They read and
write the same files you do through structured tools, so every edit leaves a
trail you can diff, revert, or hand to another agent.

## Read next

- [Pages and markdown](pages-and-markdown) — how pages, frontmatter, and block IDs work
- [AI agents](agents) — the AI panel, default agents, and activating specialists
- [Search and navigation](search-and-navigation) — \`Cmd+K\`, wiki-links, backlinks
- [Keyboard shortcuts](keyboard-shortcuts) — the full reference

Then open the [Carousel](/carousel) folder to see every supported file type
render in-place.
`,
  );

  seedFile(
    join(dataDir, "getting-started", "pages-and-markdown.md"),
    `---
schema: 1
id: ${ulid()}
title: Pages and Markdown
kind: page
created: ${now}
modified: ${now}
tags: [onboarding]
icon: lucide:file-text
---

# Pages and Markdown

Every page is a single markdown file on disk. The file path is the URL; the
folder structure is the tree you see in the sidebar. No database stores the
hierarchy — \`ls\` and \`git log\` are authoritative.

## Frontmatter

Each page opens with a YAML block:

\`\`\`yaml
---
schema: 1
id: 01JABCDEF...       # ULID — survives renames and moves
title: My Page
kind: page             # page | source | wiki
created: 2026-01-01T00:00:00.000Z
modified: 2026-01-01T00:00:00.000Z
tags: [optional, list]
icon: lucide:file-text # any Lucide icon name
---
\`\`\`

The \`id\` is permanent. Move or rename the file and every backlink still
resolves.

## Page kinds

- **page** — the default. Human-authored, agent-editable.
- **source** — raw inputs (meeting notes, interview transcripts, dumps).
  Agent-immutable. Use when you want a canonical record that no agent can
  rewrite.
- **wiki** — agent-maintained synthesis pages. Agents aggregate from
  \`source\` pages and update these as knowledge evolves.

## Block IDs

Agents edit at block granularity, not by overwriting the file. Each
paragraph, heading, or list block can carry a stable ID in an HTML comment:

\`\`\`markdown
## Launch checklist <!-- #blk_01JABC... -->

- [ ] Copy review
- [ ] Asset handoff
\`\`\`

You never need to type these. They appear when an agent first edits a
block. Once assigned, they stay — so when an agent says "I updated
\`#blk_01JABC\`" you can scroll to the exact spot.

## Auto-save and conflicts

The editor auto-saves 500 ms after you stop typing. Every write carries
the ETag from the last read, so if an agent (or another tab, or \`vim\`)
changes the same file first, you see a conflict banner instead of a silent
overwrite.
`,
  );

  seedFile(
    join(dataDir, "getting-started", "agents.md"),
    `---
schema: 1
id: ${ulid()}
title: AI Agents
kind: page
created: ${now}
modified: ${now}
tags: [onboarding, agents]
icon: lucide:bot
---

# AI Agents

Open the AI panel with \`Cmd+Shift+A\` (or the sparkle icon in the top bar).
Every agent in your project lives in \`.agents/\` as a plain markdown file
with a persona definition — you can read them, edit them, or commit them.

## Two default agents

- **General** — read-only assistant. Searches your pages, cites
  block-level sources, and never mutates anything. Good for "what did we
  decide about X?" questions.
- **Editor** — handles explicit edit requests. Shows a dry-run diff before
  writing. Respects \`kind: source\` pages (never touches them).

## The agent library

Three specialist personas live in \`.agents/.library/\` as inactive
templates: **Wiki Gardener** (orphan / stale-source / contradiction
audits), **Researcher** (thesis-driven investigation with verdicts), and
**Evolver** (self-improvement loop that proposes edits to shared skill
files). Each has dedicated tooling that the Editor + Librarian defaults
can't replicate, and each has a scheduled heartbeat (cron) plus a scope
that limits which folders it can read or write.

The fastest way to activate a template is from the UI: open
**Settings → Agents → Library**, find the row for the persona you want,
and click **Activate**. The button copies the persona to
\`.agents/<slug>/persona.md\` and registers an \`agent_state\` row so the
heartbeat scheduler picks it up on the next tick — no restart needed.

Need a persona the library doesn't ship? Use **Settings → Agents →
Custom** to compose one through the Visual Agent Builder — name, role,
constraints, scope, and review mode all map to the same persona-yaml
shape the seeded templates use.

## Wiki Gardener

The Wiki Gardener is the default opt-in maintenance persona. Activate it
once and a weekly heartbeat runs four lint checks across your vault:

- **Orphans** — markdown pages with zero inbound wiki-links.
- **Stale sources** — wiki pages older than the \`kind: source\` pages
  they cite.
- **Contradiction flags** — typed wiki-links the author wrote with
  \`[[other | contradicts]]\` (or \`disagrees\` / \`refutes\`).
- **Provenance gaps** — agent-authored blocks that shipped without a
  \`derived_from\` citation in the \`.blocks.json\` sidecar.

Each run writes a single page at
\`_maintenance/lint-<YYYY-MM-DD>.md\` (\`kind: wiki\`), appends a one-line
entry to \`_log.md\`, and adds a backlink under the Maintenance heading
of \`_index.md\`. The gardener flags; it doesn't auto-fix. Resolution is
the human's call.

The lint workflow lives in \`.agents/.shared/skills/lint.md\` — every
agent that opts into \`skills: [lint]\` gets the same recipe.

## Providers

Ironlore has no mandatory cloud dependency. Pick one:

- **No AI** — the editor, search, and terminal all work without a key.
  The AI panel shows a hint until you connect a provider.
- **Ollama** — if \`http://127.0.0.1:11434\` answers, Ironlore auto-detects
  your local models on first launch. One click to set a default.
- **Bring your own key** — Anthropic or OpenAI, entered in Settings and
  encrypted into the per-project vault.

No model weights ship with Ironlore. You supply the brain.
`,
  );

  seedFile(
    join(dataDir, "getting-started", "search-and-navigation.md"),
    `---
schema: 1
id: ${ulid()}
title: Search and Navigation
kind: page
created: ${now}
modified: ${now}
tags: [onboarding]
icon: lucide:search
---

# Search and Navigation

## Command palette

Hit \`Cmd+K\` to open the search dialog. It queries SQLite FTS5 against
every page body and filename — results come back in milliseconds on
thousands of pages. Arrow keys navigate, \`Enter\` opens.

With no query, the palette shows your ten most recently edited pages, so
jumping back to what you were working on never requires typing.

The \`all projects\` toggle in the dialog's header switches scope from
the current project to every project on this install. Foreign-project
hits are tagged with the source project name. Agents only see the
current project unless Airlock is on (\`kb.global_search\`).

## Wiki-links

Link between pages with double brackets:

\`\`\`markdown
See [[Getting Started]] for the overview.
Reference a specific block: [[Pages and Markdown#blk_01JABC]].
\`\`\`

Links resolve by page title and track through renames (the ULID \`id\` is
the real target). Broken links render dimmed.

## Backlinks

Any page that links to the current page shows in the backlinks pane.
Click a backlink to jump. Backlinks are computed incrementally — opening
a 5 000-page KB doesn't block the UI.

## Tree navigation

The sidebar renders the filesystem. Arrow keys walk siblings and
parent/child. \`Enter\` opens, \`Cmd+N\` creates a sibling, \`Cmd+Shift+N\`
creates a child.
`,
  );

  seedFile(
    join(dataDir, "getting-started", "keyboard-shortcuts.md"),
    `---
schema: 1
id: ${ulid()}
title: Keyboard Shortcuts
kind: page
created: ${now}
modified: ${now}
tags: [onboarding, reference]
icon: lucide:keyboard
---

# Keyboard Shortcuts

Every shortcut in Ironlore. Mac modifiers shown; on Linux/Windows
substitute \`Ctrl\` for \`Cmd\`.

## Navigation

| Shortcut | Action |
|---|---|
| \`Cmd+K\` | Open command palette / search |
| \`Cmd+P\` | Jump to recent page |
| \`Cmd+B\` | Toggle sidebar |
| \`Cmd+Shift+A\` | Toggle AI panel |
| \`Cmd+\`\` | Toggle terminal |

## Editing

| Shortcut | Action |
|---|---|
| \`Cmd+S\` | Force save (auto-save also runs on idle) |
| \`Cmd+Z\` / \`Cmd+Shift+Z\` | Undo / redo |
| \`Cmd+/\` | Toggle source-mode (CodeMirror) vs WYSIWYG (ProseMirror) |

## Pages and tree

| Shortcut | Action |
|---|---|
| \`Cmd+N\` | New sibling page |
| \`Cmd+Shift+N\` | New child page |
| \`F2\` | Rename selected page |
| \`↑\` / \`↓\` | Move between siblings in the tree |
| \`→\` / \`←\` | Expand / collapse folder |

## Agents

| Shortcut | Action |
|---|---|
| \`Cmd+Enter\` (in AI panel) | Send message |
| \`Cmd+.\` | Stop streaming response |
`,
  );

  // Authoring guide for connector skills — points at the three
  // worked examples seeded into `.agents/.shared/skills/`.
  seedFile(
    join(dataDir, "getting-started", "connectors.md"),
    `---
schema: 1
id: ${ulid()}
title: Connector Skills
kind: page
created: ${now}
modified: ${now}
tags: [onboarding, agents, connectors]
icon: lucide:plug
---

# Connector Skills

Connector skills are markdown templates that teach an agent how to
talk to an external service — GitHub, a Slack webhook, a private
HTTP API — using Ironlore's existing primitives. They're inert
text on disk; the model loads them when its persona declares
\`skills: [<name>]\` in frontmatter, and the actual network call
lands through \`fetchForProject\` so the project's egress
allowlist is the trust boundary.

Three worked examples ship in \`.agents/.shared/skills/\` as a
starting point:

| File | Pattern |
|---|---|
| [github-issue-search.md](/.agents/.shared/skills/github-issue-search) | Bearer-token auth, JSON GET, paginated reads. |
| [webhook-trigger.md](/.agents/.shared/skills/webhook-trigger) | Fire-and-forget POST against Slack / Discord / n8n / Make. |
| [http-get-with-auth.md](/.agents/.shared/skills/http-get-with-auth) | Parametric template — Bearer / API-key / Basic auth shapes. |

## How to author a new connector

1. **Pick the upstream's host(s).** Add each one to your project's
   \`project.yaml\` under \`egress.allowlist\`. Sub-domains and
   ports are matched literally — \`hooks.slack.com\` does not
   unlock \`*.slack.com\`. Without this entry,
   \`fetchForProject\` throws \`EgressBlockedError\` and the call
   never leaves the host.
2. **Decide where the secret lives.** Per-project API keys belong
   in the project's encrypted vault under a slot like
   \`bearer:<service>\` or \`webhook:<name>\`. Never inline secrets
   into the skill markdown — the file is git-tracked.
3. **Document the request shape.** Include the full HTTP verb +
   headers + body in a fenced code block. The model reads this
   verbatim when planning the call.
4. **Document the error shape.** A skill is only as useful as its
   failure mode. Spell out what to return on \`401\` / \`404\` /
   \`429\` / 5xx / \`EgressBlocked\` so the agent's transcript stays
   structured. The three seeded skills share a consistent JSON
   shape — copy it.
5. **Compose with \`kb.*\`.** A skill that pulls remote data should
   write the result back through \`kb.create_page\` or
   \`kb.replace_block\` (with \`derived_from\` set) so the answer
   survives across runs. Otherwise the model re-fetches every
   conversation and the cost compounds.

## When *not* to write a connector skill

- **You're integrating a service that ships an MCP server.**
  Register the MCP server in \`project.yaml\` and let the
  \`mcp.<server>.<tool>\` surface handle the protocol. MCP is the
  import path for the existing ecosystem; connectors are for
  upstreams without one.
- **The integration is two-way + stateful.** Connector skills are
  one-shot patterns — fetch, summarise, optionally write back.
  Long-running interactive sessions (a chat upstream that holds
  state) need a real provider, not a skill.

See [docs/04-ai-and-agents.md §Skills vs tools](https://github.com/anthropics/ironlore/blob/main/docs/04-ai-and-agents.md#skills-vs-tools)
for the fuller skills-vs-tools framing.
`,
  );

  // -------------------------------------------------------------------------
  // Convention pages — seeded empty so the Wiki Gardener has somewhere to
  // write. Described in docs/04-ai-and-agents.md §Convention pages. Both are
  // non-destructive: a user who already has these files keeps them.
  // -------------------------------------------------------------------------
  seedFile(
    join(dataDir, "_index.md"),
    `---
schema: 1
id: ${ulid()}
title: Vault Index
kind: wiki
created: ${now}
modified: ${now}
tags: [meta]
icon: lucide:list-tree
---

# Vault Index

The current map of this vault's \`kind: wiki\` pages. Maintained by the
Wiki Gardener on its weekly heartbeat; safe to edit by hand — the
gardener merges rather than overwrites.

## Maintenance

_Populated once the Wiki Gardener lint skill runs._
`,
  );

  seedFile(
    join(dataDir, "_log.md"),
    `---
schema: 1
id: ${ulid()}
title: Activity Log
kind: wiki
created: ${now}
modified: ${now}
tags: [meta]
icon: lucide:scroll-text
---

# Activity Log

Append-only record of agent runs and maintenance actions against this
vault. Newest entries go on top. Each entry is one line:

\`- <ISO timestamp> · <action> · <short summary> · <optional block-ref>\`

Readable at a glance; grep-friendly for the Wiki Gardener's lint skill
to scope each run to recent changes.
`,
  );

  // -------------------------------------------------------------------------
  // Carousel — showcase of supported file types
  // -------------------------------------------------------------------------
  seedFile(
    join(dataDir, "carousel", "index.md"),
    `---
schema: 1
id: ${ulid()}
title: Carousel
kind: page
created: ${now}
modified: ${now}
tags: [examples]
icon: lucide:layout-grid
---

# Carousel

Ironlore renders each of these without leaving the keyboard. Click a file
in the sidebar to see it.

- [[document]] — rich markdown (headings, lists, code, tables)
- \`spreadsheet.csv\` — editable spreadsheet grid
- \`diagram.mermaid\` — rendered flowchart with a source toggle
- \`code.ts\` — TypeScript with syntax highlighting
- \`slide.pdf\` — paginated PDF with page nav, zoom, rotate, download
- \`photo.png\` — zoomable image viewer with rotate and download
- \`drawing.svg\` — vector image rendered inline
- \`notes.txt\` / \`server.log\` — plain-text viewers (CodeMirror, no highlighting)
- \`transcript.vtt\` — timestamped caption table
- \`message.eml\` — email with parsed headers and text body
- \`notebook.ipynb\` — Jupyter notebook with markdown, code, and output cells

The other supported types — \`.docx\`, \`.xlsx\`, \`.mp3\`, \`.mp4\` — open in
dedicated viewers when you drop a real file in. They're not seeded because a
meaningful sample would be too large for a first-run bootstrap.
`,
  );

  seedFile(
    join(dataDir, "carousel", "document.md"),
    `---
schema: 1
id: ${ulid()}
title: Document
kind: page
created: ${now}
modified: ${now}
tags: [examples]
icon: lucide:file-text
---

# A Markdown Showcase

This page exercises the renderer end-to-end so you can see how Ironlore
treats common structures.

## Lists

- Bullet lists support **bold**, *italics*, and \`inline code\`
- Nested items indent cleanly
  - Two levels deep is fine
  - Three is where you ask whether this wants to be a separate page

1. Ordered lists renumber on move
2. Mix them with tasks:
   - [x] Write the overview
   - [ ] Ship the feature

## Code

\`\`\`ts
interface Page {
  id: string;
  title: string;
  kind: "page" | "source" | "wiki";
}

function isEditable(page: Page): boolean {
  return page.kind !== "source";
}
\`\`\`

## Tables

| File type | Editable | Viewer |
|---|---|---|
| Markdown | Yes | ProseMirror + CodeMirror |
| CSV | Yes | Spreadsheet grid |
| PDF | No | PDF.js canvas |
| Image | No | Zoom + pan |

## Quotes

> The filesystem is the product. If Ironlore stops running tomorrow, your
> data is still plain markdown you can grep, diff, and version.

## Links

Internal: [[Getting Started]]. External:
[the repo](https://github.com/ironlore/ironlore).
`,
  );

  seedFile(
    join(dataDir, "carousel", "spreadsheet.csv"),
    `Name,Role,Department,Start Date,Email
Alice Johnson,Engineer,Engineering,2024-01-15,alice@example.com
Bob Smith,Designer,Product,2023-06-01,bob@example.com
Carol Lee,PM,Product,2024-03-20,carol@example.com
Dan Brown,Engineer,Engineering,2023-11-10,dan@example.com
Eve Davis,Analyst,Data,2024-07-01,eve@example.com`,
  );

  seedFile(
    join(dataDir, "carousel", "diagram.mermaid"),
    `graph TD
    A[User opens file] --> B{File type?}
    B -->|Markdown| C[ProseMirror Editor]
    B -->|PDF| D[PDF.js Viewer]
    B -->|CSV| E[Spreadsheet Viewer]
    B -->|Image| F[Image Viewer]
    B -->|Code| G[CodeMirror Viewer]
    B -->|Mermaid| H[Diagram Renderer]
    C --> I[Auto-save]
    E --> I`,
  );

  seedFile(
    join(dataDir, "carousel", "code.ts"),
    `/**
 * Sample TypeScript file for testing the source code viewer.
 */

interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "editor" | "viewer";
}

function greet(user: User): string {
  return \`Hello, \${user.name}! You are logged in as \${user.role}.\`;
}

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com", role: "admin" },
  { id: "2", name: "Bob", email: "bob@example.com", role: "editor" },
];

for (const user of users) {
  console.log(greet(user));
}

export { type User, greet };
`,
  );

  seedBinaryFile(join(dataDir, "carousel", "slide.pdf"), createMinimalPdf());
  seedBinaryFile(join(dataDir, "carousel", "photo.png"), createDemoPng());

  seedFile(
    join(dataDir, "carousel", "drawing.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" width="320" height="160">
  <rect width="320" height="160" fill="#1b2330"/>
  <circle cx="80" cy="80" r="48" fill="#3b82f6" opacity="0.85"/>
  <circle cx="160" cy="80" r="48" fill="#10b981" opacity="0.85"/>
  <circle cx="240" cy="80" r="48" fill="#f59e0b" opacity="0.85"/>
  <text x="160" y="148" fill="#e5e7eb" font-family="Inter, sans-serif" font-size="12" text-anchor="middle">SVG renders with the image viewer</text>
</svg>
`,
  );

  seedFile(
    join(dataDir, "carousel", "notes.txt"),
    `Plain-text notes live alongside markdown.

The text viewer is read-only CodeMirror with no language highlighting. Good
for quick captures you don't want to dress up as a full markdown page — log
snippets, throwaway scratchpads, clipboard dumps.

Move it to a .md file the moment it deserves structure. Until then, keep
the noise out of the editor.
`,
  );

  seedFile(
    join(dataDir, "carousel", "server.log"),
    `[2026-04-15T09:00:01.412Z] info  server listening on 127.0.0.1:3000
[2026-04-15T09:00:01.419Z] info  search-index: opened index.sqlite (wal mode)
[2026-04-15T09:00:01.423Z] info  file-watcher: chokidar backend ready
[2026-04-15T09:00:07.881Z] info  auth: login ok user=admin
[2026-04-15T09:00:08.112Z] debug pages: GET / -> 200 (12ms)
[2026-04-15T09:00:09.004Z] debug pages: GET /carousel/index.md -> 200 (3ms)
[2026-04-15T09:00:09.118Z] warn  search-index: query parsed 0 results for "carou"
[2026-04-15T09:00:12.560Z] info  editor: autosave carousel/document.md etag="abc123"
[2026-04-15T09:00:19.204Z] error ai: provider not configured — skipping agent run
`,
  );

  seedFile(
    join(dataDir, "carousel", "transcript.vtt"),
    `WEBVTT

00:00:00.000 --> 00:00:03.500
Welcome back to the Ironlore product walkthrough.

00:00:03.500 --> 00:00:08.000
Today we're opening every supported file type side-by-side.

00:00:08.000 --> 00:00:13.250
Transcripts render as a two-column table — timestamp on the left, caption
on the right.

00:00:13.250 --> 00:00:17.900
The same parser handles .vtt and .srt files.

00:00:17.900 --> 00:00:22.400
Drop one in any folder to try it.
`,
  );

  seedFile(
    join(dataDir, "carousel", "message.eml"),
    `From: Ironlore Team <hello@ironlore.app>
To: You <you@example.com>
Subject: Your first email in Ironlore
Date: Wed, 15 Apr 2026 09:00:00 +0000
Content-Type: text/plain; charset=utf-8

Hi there,

This is a plain-text .eml file, rendered by the email viewer. It parses the
envelope (From / To / Subject / Date) into a compact header block and shows
the body below in a monospaced pane.

HTML-only messages are down-converted to text by the extractor, so the
viewer never injects untrusted HTML — the same plumbing is used for the
FTS5 search index.

— The Ironlore Team
`,
  );

  seedFile(
    join(dataDir, "carousel", "notebook.ipynb"),
    JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: {
            display_name: "Python 3",
            language: "python",
            name: "python3",
          },
          language_info: { name: "python", version: "3.12.0" },
        },
        cells: [
          {
            cell_type: "markdown",
            metadata: {},
            source: [
              "# Sample Notebook\n",
              "\n",
              "This `.ipynb` file renders in the Notebook viewer.\n",
              "Markdown cells display formatted text, code cells show syntax-highlighted source,\n",
              "and output cells display results.\n",
            ],
          },
          {
            cell_type: "code",
            metadata: {},
            source: [
              "import math\n",
              "\n",
              "# Calculate the golden ratio\n",
              "phi = (1 + math.sqrt(5)) / 2\n",
              'print(f"Golden ratio: {phi:.10f}")\n',
            ],
            outputs: [
              {
                output_type: "stream",
                name: "stdout",
                text: ["Golden ratio: 1.6180339887\n"],
              },
            ],
            execution_count: 1,
          },
          {
            cell_type: "code",
            metadata: {},
            source: [
              "# A simple list comprehension\n",
              "squares = [x**2 for x in range(1, 11)]\n",
              "print(squares)\n",
            ],
            outputs: [
              {
                output_type: "stream",
                name: "stdout",
                text: ["[1, 4, 9, 16, 25, 36, 49, 64, 81, 100]\n"],
              },
            ],
            execution_count: 2,
          },
          {
            cell_type: "markdown",
            metadata: {},
            source: [
              "## Notes\n",
              "\n",
              "Ironlore extracts notebook content for full-text search.\n",
              "Both markdown prose and code cells are indexed.\n",
            ],
          },
        ],
      },
      null,
      2,
    ),
  );

  // -------------------------------------------------------------------------
  // Agent library personas
  // -------------------------------------------------------------------------
  const agentLibDir = join(dataDir, AGENTS_LIBRARY_DIR);
  const sharedSkillsDir = join(dataDir, AGENTS_SHARED_DIR, "skills");
  mkdirSync(agentLibDir, { recursive: true });
  mkdirSync(sharedSkillsDir, { recursive: true });

  // Librarian agent (seeded, not deletable). Slug stays "general"
  //  for routing/back-compat; display name is "Librarian" — fits the
  //  KB metaphor and reads as a concrete role rather than the
  //  generic "General" placeholder. The slug is the reserved
  //  routing key per build-persona.ts; the user-facing name is what
  //  changes here.
  seedFile(
    join(dataDir, AGENTS_DIR, "general", "persona.md"),
    `---
name: Librarian
slug: general
emoji: "\u{1F4DA}"
type: default
role: "Knowledge base assistant — read-mostly, citation-grounded answers"
provider: anthropic
active: true
scope:
  pages: ["/**"]
  writable_kinds: []
---

You are the Librarian for this Ironlore knowledge base. Your role is
to help users find and understand information across their pages.

## Behavior

- Search the knowledge base before answering
- Ground every claim in retrieved content
- Cite sources as [[Page#blk_...]] block refs
- When synthesizing 3+ sources, suggest filing as a wiki page
- Never modify pages — you have read-only access by default
`,
  );

  // Editor agent (seeded, not deletable)
  seedFile(
    join(dataDir, AGENTS_DIR, "editor", "persona.md"),
    `---
name: Editor
slug: editor
emoji: "\u{270F}\u{FE0F}"
type: default
role: "Page editor — structured edits with dry-run preview"
provider: anthropic
active: true
scope:
  pages: ["/**"]
  writable_kinds: [page, wiki]
---

You are the Editor assistant for this Ironlore knowledge base. You handle
explicit "edit this page" instructions from the user.

## Behavior

- Use kb.replace_block, kb.insert_after, kb.delete_block for edits
- Always carry the current ETag from kb.read_page
- Show a dry-run diff preview before applying destructive changes
- When the editor has a selection, scope your diff to selected blocks first
- Never modify kind:source pages
`,
  );

  // Library personas (inert templates, not activated)
  const personas: Array<{
    slug: string;
    name: string;
    emoji: string;
    dept: string;
    role: string;
    heartbeat: string;
    scope: string;
  }> = [
    // Curated library — only personas that earn their place in a
    //  knowledge-base product. Each entry has dedicated tooling that
    //  the Editor + Librarian defaults can't replicate:
    //   - wiki-gardener: 5 lint detectors (orphans/stale-sources/
    //     contradictions/coverage-gaps/provenance-gaps)
    //   - evolver: kb.query_failed_runs + the inbox-merged skill-edit
    //     loop
    //   - researcher: thesis.md skill (decompose → evidence → verdict),
    //     seeded by seed-agents.ts as a `.library/<slug>/` template
    //     shape rather than the flat `<slug>.md` shape used here
    //
    //  Cut history: an earlier "fake corporate team" set
    //  (CEO / Content Marketer / SEO Specialist / Product Manager /
    //  Technical Writer / etc.) was retired because they were persona
    //  theatre with no dedicated tooling — anyone wanting one can
    //  build it through the Visual Agent Builder in Settings → Agents
    //  in 30 seconds. See [docs/04-ai-and-agents.md §Default agents](../../docs/04-ai-and-agents.md).
    {
      slug: "wiki-gardener",
      name: "Wiki Gardener",
      emoji: "\u{1F33F}",
      dept: "Maintenance",
      role: "Wiki health — orphan detection, stale pages, link rot",
      heartbeat: "0 6 * * 0",
      scope: "/**",
    },
    {
      // Phase-11 self-improvement loop. Weekly cron; reviews the
      // last 7 days of failed + retried agent runs, identifies
      // recurring patterns, and proposes a markdown edit to a
      // shared skill file. Always runs under `review_mode: inbox`
      // so every proposed edit lands on a staging branch the user
      // approves via the existing inbox UI before merge.
      slug: "evolver",
      name: "Evolver",
      emoji: "\u{1F9EC}",
      dept: "Maintenance",
      role: "Skill evolution — analyse failed runs, propose skill edits",
      heartbeat: "0 7 * * 0",
      scope: "/.agents/.shared/skills/**",
    },
  ];

  for (const p of personas) {
    // The wiki-gardener + evolver opt into workflow skills at seed
    // time. Other specialists stay skill-free until the user wires
    // them up by hand — the framework is opt-in (see skill-loader.ts).
    let skillsLine = "";
    if (p.slug === "wiki-gardener") skillsLine = "\nskills: [lint, ingest]";
    else if (p.slug === "evolver") skillsLine = "\nskills: [evolve]";
    // The evolver always runs under inbox review — every skill-file
    // edit it proposes lands on a staging branch the user approves
    // before merge. That's the safety property the SkillClaw-style
    // loop trades on: the AI suggests a plain-text markdown edit,
    // the human approves it.
    const reviewLine = p.slug === "evolver" ? "\nreview_mode: inbox" : "";
    // Per Principle 5a, synthesis personas declare
    // `readable_kinds: [source]` so the sources-not-compilations
    // constraint is visible in their config. The wiki-gardener
    // operates the ingest workflow; other specialists keep the
    // wider read scope (navigation + cross-referencing) by leaving
    // the field absent → all kinds readable, the existing default.
    const readableLine = p.slug === "wiki-gardener" ? "\n  readable_kinds: [source]" : "";
    // The evolver writes to skill files (no `kind:` marker → fall
    // through to the gate's permissive default), but should NOT
    // mutate `kind: source` or `kind: wiki` content. Pin
    // `writable_kinds: [page]` so the gate enforces that boundary.
    const writableKinds = p.slug === "evolver" ? "[page]" : "[page, wiki]";
    const frontmatter = `---
name: ${p.name}
slug: ${p.slug}
emoji: "${p.emoji}"
type: specialist
department: ${p.dept}
role: "${p.role}"
provider: anthropic
heartbeat: "${p.heartbeat}"
budget: { period: monthly, runs: 40 }
active: false${skillsLine}${reviewLine}
scope:
  pages: ["${p.scope}"]
  tags: []
  writable_kinds: ${writableKinds}${readableLine}
---`;

    // The wiki-gardener is a maintenance persona rather than a domain
    // specialist — it gets a body that names the `lint.md` workflow skill
    // and the two convention pages it reads each run, so the skill +
    // convention-page dependency is declared from day one. See
    // docs/04-ai-and-agents.md §Wiki-gardener agent.
    const body =
      p.slug === "wiki-gardener"
        ? `
You are the Wiki Gardener for this Ironlore vault. Your job is
maintenance: keeping the wiki healthy as it grows, not producing new
domain content.

## Responsibilities

${p.role}.

## How you work

1. Load the \`lint.md\` shared skill. It defines the four-class health
   check (orphans, stale sources, contradiction flags, provenance gaps)
   and the exact report shape.
2. Read \`_log.md\` at the vault root to scope each run to recent
   activity before widening to the full vault.
3. Read \`_index.md\` at the vault root as the authoritative map of
   \`kind: wiki\` pages.
4. Run the lint check. Write exactly one report page at
   \`_maintenance/lint-<YYYY-MM-DD>.md\` with \`kind: wiki\`.
5. Append a one-line entry to \`_log.md\` and a backlink entry under
   \`_index.md\` § Maintenance.
6. Close with \`agent.journal\` summarising counts and the report path.

## Guidelines

- Work within your assigned scope: \`${p.scope}\`
- Use structured kb.* tools for all edits
- Never modify \`kind: source\` pages (writable_kinds restricts this
  at the tool layer, but treat it as a design rule too)
- Flag findings; do not auto-fix — the user reviews the report and
  decides what to act on
`
        : p.slug === "evolver"
          ? `
You are the Evolver — the agent that helps Ironlore's other agents
get better at their jobs over time. You read what went wrong in the
last week of runs and propose targeted edits to the shared skill
files. Every proposed edit lands on a staging branch the user
approves through the Inbox before it merges.

## Responsibilities

${p.role}.

## How you work

1. Load the \`evolve.md\` shared skill. It defines the four-action
   choice (improve_skill / optimize_description / create_skill /
   skip), the \`NOT for:\` exclusion-syntax convention, and the
   exact diff format the user sees in the Inbox.
2. Call \`kb.query_failed_runs\` (default 168 hours = one week) to
   pull aggregated failure patterns across every agent that ran in
   this project. Look for: agents with >2 failed runs, tools that
   error repeatedly across agents, the same error string surfacing
   from multiple runs.
3. Read the relevant shared skill file via \`kb.read_page\` if a
   pattern points at one.
4. Pick **exactly one** action per run — quality over volume:
   - **improve_skill** — the skill body is missing a constraint
     that would have prevented the failures. Edit it via
     \`kb.replace_block\` or \`kb.insert_after\`.
   - **optimize_description** — the skill is fine but its
     frontmatter \`description\` doesn't match how it's actually
     being invoked. Edit the description.
   - **create_skill** — a recurring failure mode has no skill
     covering it. Draft a new shared skill via \`kb.create_page\`.
   - **skip** — none of the patterns rise above noise. Close the
     run with a journal entry explaining why; no edit.
5. When proposing a constraint addition, prefer the explicit
   \`NOT for:\` exclusion syntax (see \`evolve.md\`) — it surfaces
   in BM25 and reads loud-and-clear in the agent's loaded prompt.

## Guidelines

- Work within your assigned scope: \`${p.scope}\`. The
  writable_kinds: [page] gate keeps you out of \`kind: source\`
  and \`kind: wiki\` content.
- Always run under \`review_mode: inbox\` (already pinned in your
  frontmatter). Never auto-merge.
- One action per run. The user can approve a small edit fast;
  reviewing a sweeping rewrite is friction.
- Cite specific failed-run job IDs in your journal entry so a
  curious user can audit the evidence trail behind the proposed
  change.
`
          : "";
    if (!body) {
      throw new Error(
        `seed.ts: no persona body wired up for slug '${p.slug}'. Add a branch in the body composer.`,
      );
    }

    seedFile(join(agentLibDir, `${p.slug}.md`), `${frontmatter}\n${body}`);
  }

  // Shared skill: file-answer (single + multi-extraction modes)
  seedFile(
    join(sharedSkillsDir, "file-answer.md"),
    `---
name: File Answer
description: Save AI answers as wiki pages — single or multi-extraction from session transcripts
---

# File Answer Skill

Two modes for capturing knowledge from AI conversations:

## Single-answer mode

When the user clicks "Save this answer", create a \`kind: wiki\` page:
1. Set \`source_ids\` to the pages you cited in the answer.
2. Each block carries \`derived_from\` pointing at the cited block-refs.
3. Add a backlink entry in \`_index.md\` (if it exists).

## Multi-extraction mode

When processing a session transcript (e.g., from \`ironlore scribe\`):
1. Read the full transcript.
2. Identify distinct knowledge items: decisions, discoveries, corrections, summaries.
3. For each item, propose a wiki page with:
   - \`kind\`: decision | discovery | correction | summary
   - \`title\`: descriptive slug
   - \`path\`: suggested location under \`wiki/\` or the relevant folder
   - \`markdown\`: the drafted page body
   - \`derived_from\`: cite the session-log block
4. Present ALL proposals for user approval before writing ANY of them.
5. Nothing writes to disk without a user keystroke.

## Credibility rubric (for ingest mode)

Before creating a \`kind: source\` page, score the material:

| Signal | +1 | 0 | -1 |
|---|---|---|---|
| Peer review | Published in peer-reviewed venue | Unknown | Self-published |
| Recency | Within 2 years | 2-5 years | >5 years (fast-moving field) |
| Authority | Named expert, institutional | Unknown | Anonymous |
| Primary vs secondary | Primary research | Secondary synthesis | Aggregator / SEO |
| Corroboration | Corroborated by existing KB source | No overlap | Contradicts high-confidence source |

Score → confidence: high (3-5), medium (1-2), low (0), reject (<0).
`,
  );

  // Shared skill: brand voice
  seedFile(
    join(sharedSkillsDir, "brand-voice.md"),
    `---
name: Brand Voice
description: Project-wide tone and style guidelines
---

# Brand Voice Skill

When writing or editing content, follow the brand voice guidelines defined
in the knowledge base. Look for a brand-voice or style-guide page in the
project and adopt its tone, vocabulary, and formatting rules.

If no brand voice page exists, use a professional, concise tone:
- Active voice over passive
- Short paragraphs (2-3 sentences)
- Technical accuracy without jargon overload
`,
  );

  // Shared skill: lint — wiki health check loaded by the Wiki Gardener.
  // Implements the four-class lint contract from docs/04-ai-and-agents.md
  // §Workflow skills — lint.md. Orphans use a real primitive today;
  // stale sources, contradiction flags, and provenance gaps document
  // honest stub status so the model does not fabricate findings.
  seedFile(
    join(sharedSkillsDir, "lint.md"),
    `---
name: Lint
description: Wiki health check — orphans, stale sources, contradiction flags, coverage gaps, provenance gaps
---

# Lint Skill

A periodic health check over the whole vault. Produces a single \`kind: wiki\`
report page; never rewrites source pages, never auto-fixes. The user reads
the report and decides what to act on.

## When to run

Loaded by the Wiki Gardener on its weekly heartbeat. Can also be invoked
by the General agent on demand ("run the lint skill").

## Inputs you always read first

1. \`_log.md\` at the vault root — the append-only activity log. Skim the
   tail to see what has changed since the last lint run; scope your checks
   to recently-modified neighborhoods before widening to the full vault if
   budget allows.
2. \`_index.md\` at the vault root — the current map of \`kind: wiki\`
   pages. Use it as the authoritative list of wiki pages to cross-check
   against findings.
3. The previous lint report at \`_maintenance/lint-<latest-date>.md\` if
   one exists, so repeat findings are marked as such.

## The five checks

### 1. Orphans — pages with zero inbound wiki-links

Real check. Call \`kb.lint_orphans\` with default arguments — it
returns an array of \`{ path, updatedAt }\` for every markdown page
with no inbound wiki-link, automatically excluding
\`_maintenance/\`, \`getting-started/\`, and \`.agents/\`. The tool is
read-only and cheap; no pagination needed.

Report each orphan as a row: \`| path | kind | last-modified |\`. Read
each orphan's frontmatter via \`kb.read_page\` to pull its \`kind\` —
pages with \`kind: source\` are expected to be inbound-only, so
demote them to a "sources (expected orphans)" sub-table or drop them
from the report, depending on report verbosity preference.

### 2. Stale sources — wiki pages older than their cited sources

Real check. Call \`kb.lint_stale_sources\` with no arguments — it
returns \`{ count, stale: Array<{ wikiPath, sourcePath, wikiUpdatedAt, sourceUpdatedAt }> }\`
for every wiki page with an outbound wiki-link to a \`kind: source\`
page that has been modified more recently than the wiki itself.

Report each pair as a row: \`| wiki | source | staleness |\` where
staleness is a human-readable delta between the two timestamps
(\`sourceUpdatedAt - wikiUpdatedAt\`). A stale row is a prompt for
human review — the source may have new facts that invalidate the
synthesis, or the change may be cosmetic and require no action.
Flag; do not auto-fix.

### 3. Contradiction flags — peer claims that disagree

Real check. Call \`kb.lint_contradictions\` with no arguments — it
returns \`{ count, contradictions: Array<{ sourcePath, targetPath, rel, linkText }> }\`
for every wiki-link the author wrote with a typed
\`contradicts\` / \`disagrees\` / \`refutes\` relation
(\`[[other | contradicts]]\` syntax — see
[01-content-model.md](../../../../docs/01-content-model.md) §Wiki-link
relations).

Report each pair as a row: \`| source | target | rel |\`. The lint
tool intentionally does not invent contradictions — Phase 1 only
surfaces what the author already flagged. A future detector can layer
LLM analysis on top to propose pairs the author missed.

### 4. Coverage gaps — concepts the vault keeps citing but never wrote up

Real check. Call \`kb.lint_coverage_gaps\` with no arguments — it
queries the backlinks table for wiki-link target labels that ≥3
distinct pages cite but no page actually exists for. Returns
\`{ count, gaps: Array<{ target, mentionedBy, citationCount }> }\`,
sorted by citation count descending. Threshold of 3 keeps stray
typos and one-off references out of the report.

Report each gap as a row: \`| target | citations | first 3 citing pages |\`.
A coverage gap is a prompt for the user to write the page (or for
a future ingest workflow to draft a stub); flag, do not auto-create.

### 5. Provenance gaps — agent-authored blocks missing \`derived_from\`

Real check. Call \`kb.lint_provenance_gaps\` with no arguments — it
walks the \`.blocks.json\` sidecars under \`data/\` and returns
\`{ count, gaps: Array<{ pagePath, blockId, agent, compiledAt }> }\`
for every block where \`agent\` is set (= written by an agent run
through \`kb.replace_block\` / \`kb.insert_after\` / \`kb.create_page\`)
but \`derived_from\` is missing or empty.

Report each gap as a row: \`| page#blockId | agent | compiled-at |\`.
A gap is a prompt for the authoring agent to revisit and add a
citation; flag, do not auto-fix.

## Report output

Write **exactly one** page at \`_maintenance/lint-<YYYY-MM-DD>.md\` with
frontmatter \`kind: wiki\`, \`created\` = today's ISO date. Structure:

\`\`\`markdown
# Lint report — <YYYY-MM-DD>

## Summary
- Orphans: N
- Stale sources: N
- Contradiction flags: N
- Coverage gaps: N
- Provenance gaps: N

## Orphans
<table of orphan rows or "None.">

## Stale sources
<table of stale-source rows or "None.">

## Contradiction flags
<table of contradiction rows or "None.">

## Coverage gaps
<table of coverage-gap rows or "None.">

## Provenance gaps
<table of provenance-gap rows or "None.">
\`\`\`

After writing the report, append a one-line entry to \`_log.md\`:
\`- <ISO timestamp> · lint · <N> orphans · [[_maintenance/lint-<date>]]\`.
Then add a backlink entry in \`_index.md\` under a "Maintenance" heading
if the heading exists, otherwise create it.

Close the run with \`agent.journal\` and **always** pass the structured
\`lintReport\` field — the server reads it to fire a dismissible banner
in the user's UI ("3 stale pages, 1 contradiction · view report"). A
journal call without \`lintReport\` finalizes the run silently:

\`\`\`json
{
  "text": "<prose summary of counts + report path>",
  "lintReport": {
    "reportPath": "_maintenance/lint-<YYYY-MM-DD>.md",
    "counts": {
      "orphans": <N>,
      "stale": <N>,
      "contradictions": <N>,
      "coverageGaps": <N>,
      "provenanceGaps": <N>
    }
  }
}
\`\`\`
`,
  );

  // Shared skill: ingest — process a new source page into the
  // wiki. The five-step Make-like pipeline (Diff → Summarize →
  // Extract → Write → (Images, deferred)) the proposal calls for,
  // baked into a workflow skill the wiki-gardener (or any other
  // persona) loads on demand. Like `lint.md`, this is a markdown
  // template the agent reads at run-start; tool calls are real but
  // the orchestration lives in prose so the user can audit and
  // edit it without touching code.
  //
  // Per Principle 5a + the wiki-gardener's `readable_kinds:
  // [source]` declaration, synthesis reads source pages only —
  // never other wiki pages — so each compilation layer hashes back
  // to ground truth via `derived_from`.
  seedFile(
    join(sharedSkillsDir, "ingest.md"),
    `---
name: Ingest
description: Process a new source page into the wiki via the five-step pipeline (Diff → Summarize → Extract → Write → Images)
---

# Ingest Skill

The canonical "process a new source" workflow. The user dropped raw
material — a clipped article, a transcript, an uploaded PDF, a
pasted note — into the vault as a \`kind: source\` page. This skill
turns it into one or more \`kind: wiki\` pages that synthesise the
material, citing the source via \`derived_from\` block-refs and
\`source_ids\` frontmatter.

Treat the agent like \`make\` — a strict procedural engine, not an
improviser. Each phase has a defined input, a defined output, and a
defined tool to run. Skip phases that don't apply, but don't
collapse them.

## When to run

- Loaded by the Wiki Gardener (or any persona that lists \`ingest\`
  in its \`skills:\` frontmatter) when a new \`kind: source\` page
  appears in \`_log.md\` since the last run.
- Invokable on demand: "ingest the spoke I dropped in
  \`sources/2026-04-25-research.md\`."

## The Sources-not-Compilations rule

This skill operates under Principle 5a. **Never read another
\`kind: wiki\` page as factual input for synthesis.** The persona
loading this skill should declare \`readable_kinds: [source]\` so
the constraint is visible in its config; in practice it means: when
this skill calls \`kb.read_page\`, the target should be a
\`kind: source\` page (or an unmarked \`kind: page\`), not a
\`kind: wiki\` page derived by some earlier ingest run.

If you find yourself wanting to read a wiki page to "save a
synthesis step," stop — that's exactly the hallucination-
accumulation failure mode the principle exists to prevent. Re-read
the original sources instead.

## The five steps

### 1. Diff — what changed?

Read \`_log.md\` and the previous ingest run's journal entry (in
\`agents/<your-slug>/memory/home.md\`). Identify:

- **New sources** — \`kind: source\` pages that didn't exist on the
  last run.
- **Modified sources** — \`kind: source\` pages whose \`modified\`
  timestamp is newer than your last run, AND whose ETag changed.

Skip the rest of the steps if there's nothing new — close with
\`agent.journal\` summarising "no new sources" and exit.

### 2. Summarize — distil each source to a paragraph

For each source page identified in step 1, call
\`kb.read_page\` to get the full content, then write a one-paragraph
summary into your scratch buffer. **Don't write anything to disk in
this step.** The summary is a working artefact, not a stored
output.

The summary should answer: what's the core claim? What's the
strongest piece of evidence? What's the one sentence that, if quoted,
captures the spirit of the source?

### 3. Extract — pull entities, concepts, and action items

For each summary in step 2, list:

- **Entities** the source mentions by name (people, places, products,
  technologies). Cross-reference against \`_index.md\` to see
  which already have wiki pages.
- **Concepts** the source advances or refutes — these are
  candidate wiki-page topics if no page yet exists. The
  \`kb.lint_coverage_gaps\` tool surfaces concepts the vault keeps
  citing without writing up; consult its most recent report at
  \`_maintenance/lint-<latest-date>.md\` for guidance.
- **Action items** the user or you should follow up on — these go
  in the journal, not into wiki pages.

### 4. Write — formalise into wiki pages

For each concept identified in step 3 that doesn't yet have a wiki
page:

- Call \`kb.create_page\` with \`kind: wiki\`, parent in the
  appropriate folder (default \`wiki/\`), title set to the concept
  label.
- The body is your synthesis from step 2 + 3 — written in your
  own voice, citing the source explicitly via inline
  \`[[source/path#blk_…]]\` block-refs for every factual claim.
- After creating the page, call \`kb.replace_block\` for each
  synthesis block with \`derived_from: ["source/path#blk_…"]\`
  so the per-block provenance chain is auditable. The trust score
  ([04-ai-and-agents.md §Trust score](../../../../docs/04-ai-and-agents.md))
  reads this to render \`fresh / stale / unverified\` per block.

For each existing wiki page where a new source adds material:

- Call \`kb.read_page\` on the existing wiki to get its current
  content + ETag.
- Use \`kb.insert_after\` to append a new block (synthesised from
  the new source, not from the existing wiki body — Principle 5a)
  with \`derived_from\` pointing at the new source's blocks.
- Update the wiki page's frontmatter \`source_ids\` to include
  the new source's ULID.

**Never** rewrite an existing wiki block from another wiki block.

### 5. Images — local-only handling (deferred for now)

If a source page references binary assets (PNG, SVG, PDF), Ironlore
keeps them as raw files alongside the source. Today this skill
**doesn't extract or rewrite those assets** — it just notes their
paths in the wiki page's body so the user can navigate. A future
iteration may add an image-extraction tool; until then, leave a
\`> Images: [list of paths]\` quote at the bottom of any wiki page
that should reference them.

## Closing

After step 4 (and 5 if applicable):

1. Append a one-line entry to \`_log.md\`:
   \`- <ISO timestamp> · ingest · <N> sources processed · <N> wiki pages touched\`.
2. Close the run with \`agent.journal\` summarising counts, the
   list of touched wiki paths, and any action items from step 3
   that need user attention. Generic runs don't surface a banner —
   the journal entry is enough — so don't pass \`lintReport\`
   (that's for the lint workflow only).
`,
  );

  // Shared skill: evolve — the agent self-improvement loop. The
  // Evolver loads this on its weekly heartbeat to read aggregated
  // failure patterns from `kb.query_failed_runs` and propose a
  // single targeted edit to a shared skill file. Always inbox-mode
  // so the human approves the diff before merge — the safety
  // property the SkillClaw-style loop trades on.
  seedFile(
    join(sharedSkillsDir, "evolve.md"),
    `---
name: Evolve
description: Skill self-improvement — analyse failed agent runs, propose one targeted skill edit per heartbeat
---

# Evolve Skill

A weekly self-improvement pass over the project's shared skill files.
The agent reads aggregated failure patterns from the past week of
agent runs, picks **exactly one** structured action, and proposes
the resulting markdown edit on a staging branch the user approves
through the Inbox.

## When to run

Loaded by the **Evolver** library persona on its weekly heartbeat
(default Sunday 07:00). The persona declares
\`review_mode: inbox\` — every edit lands on a branch named
\`agents/evolver/<run-id>\` and waits for human approval. **Never
merge without human review**; that's the entire safety property.

## Inputs you always read first

1. \`kb.query_failed_runs\` — call with default arguments
   (\`sinceHours: 168\`, one week). Returns
   \`{ window, perAgent, perTool }\`:
   - \`perAgent[]\` — every agent with ≥1 failed-or-retried run in
     the window, sorted by \`runCount\` desc. Each row carries
     \`runCount\`, \`retryCount\`, \`lastError\` (truncated to 240
     chars).
   - \`perTool[]\` — every tool that emitted a \`tool.error\` event
     in the window, sorted by \`errorCount\` desc.
2. The skill file the pattern points at, if any. Use
   \`kb.read_page\` against the path your analysis identifies (e.g.
   \`.agents/.shared/skills/file-answer.md\`).
3. The previous evolver run's journal entry (in
   \`agents/evolver/memory/home.md\`) so repeat findings get
   acknowledged rather than re-proposed every week.

## The four actions

Pick **exactly one** per run. The user can approve a small focused
edit in seconds; reviewing a sweeping rewrite is friction that kills
the loop's compounding value.

### 1. \`improve_skill\` — the skill body is missing a constraint

Use when: a skill is being invoked correctly per its description,
but the agent is making a recurring mistake the skill body doesn't
anticipate. E.g. "the researcher keeps batching 50 URLs at a time
into \`http-get-with-auth\` and rate-limiting itself."

Action: call \`kb.replace_block\` (or \`kb.insert_after\`) to add a
constraint section. **Prefer the explicit \`NOT for:\` exclusion
syntax** described below — it surfaces in BM25 and reads
loud-and-clear in the agent's loaded prompt.

### 2. \`optimize_description\` — the description misframes the skill

Use when: agents are loading a skill in the wrong context (or
failing to load it when they should). E.g. "the
\`brand-voice\` skill says 'for marketing copy' but it's getting
loaded by the researcher because the agent reads 'voice' as
'tone'."

Action: \`kb.replace_block\` against the skill's frontmatter
description block, tightening or rewriting the trigger phrasing.
Don't touch the body in this action.

### 3. \`create_skill\` — a failure mode has no skill at all

Use when: a recurring failure pattern (3+ failed runs across 2+
agents) has no shared skill addressing it. E.g. multiple agents
all hitting "kb.replace_block: ETag mismatch" because they re-read
pages but don't re-read between successive edits.

Action: \`kb.create_page\` at \`.agents/.shared/skills/<slug>.md\`
with \`kind\` left absent (skills aren't pages or wikis). Frontmatter
must include \`name\` + \`description\`. Body explains *when to load
this skill* + *what constraints it imposes*.

### 4. \`skip\` — nothing rises above noise this week

Use when: the failures in the window are one-off (single retry,
single agent, no clear pattern) or already addressed by a recent
evolver edit the user approved.

Action: close the run with \`agent.journal\` explaining what you
saw and why no edit is warranted. No skill mutations.

## The \`NOT for:\` exclusion syntax

A small markdown convention that improves both human-readable
intent and BM25 retrieval ranking. When a skill is *unsuitable*
for a class of tasks, document it explicitly:

\`\`\`markdown
## NOT for:
- batching more than 3 URLs at a time (the upstream rate-limits at
  10 req/min and silently fails)
- POST requests carrying secrets in the body (use the vault, not
  the connector skill)
- streaming endpoints (this skill assumes one-shot JSON; use
  \`http-stream\` for SSE)
\`\`\`

The agent loading the skill sees these as hard constraints. The
search index sees high keyword density on the failure modes — so
when a future agent searches for "how do I batch URLs," the
correct skill ("yes, here's how, but NOT more than 3") ranks above
the wrong skill that doesn't mention the constraint at all.

## Closing

After your single action (or skip):

1. Append a one-line entry to \`_log.md\`:
   \`- <ISO timestamp> · evolve · <action> · <skill-path-or-skip-reason>\`.
2. Close with \`agent.journal\`. The journal entry must:
   - Name the action you picked (\`improve_skill\` / \`optimize_description\` / \`create_skill\` / \`skip\`).
   - Cite at least 2 failed-run job IDs from \`kb.query_failed_runs\` so a
     curious user can audit the evidence trail.
   - State the one-sentence rationale ("agents kept hitting X, the
     edit adds a constraint preventing X").

The inbox entry the user sees in the UI is the diff your
\`kb.replace_block\` / \`kb.create_page\` produced. Approving it
merges to main; rejecting it discards the staging branch.
`,
  );

  // ─── Connector-skill examples ──────────────────────────────────────
  // Three worked-out templates for users authoring their own
  // upstream connectors. Each documents:
  //   1. The `project.yaml` `egress.allowlist` entry the skill needs
  //      so `fetchForProject` lets the network call through.
  //   2. The auth handoff pattern (env var → vault → header).
  //   3. The error shape the skill should return so the agent's
  //      transcript stays structured.
  // Connectors are inert markdown today: the model reads them when
  // the persona declares `skills: [<name>]`, and the actual HTTP
  // execution path (an MCP server or a future generic `http.fetch`
  // tool) routes through `fetchForProject`. See
  // docs/04-ai-and-agents.md §Skills vs tools and
  // docs/05-jobs-and-security.md §Network egress.

  // GitHub issue search — Bearer-token auth, JSON GET, paginated.
  seedFile(
    join(sharedSkillsDir, "github-issue-search.md"),
    `---
name: GitHub Issue Search
description: Read-only search over a GitHub repo's issues + pull requests (Bearer auth)
---

# GitHub Issue Search Skill

Use this skill when the user asks about issues, pull requests, or
discussions in a configured GitHub repository — for instance
"summarise the open issues tagged \`good-first-issue\`" or "what's
the status of PR #42?". This is a read-only connector; do **not**
mutate upstream state.

## project.yaml entry

Add the host to the project's egress allowlist or
\`fetchForProject\` will block the call:

\`\`\`yaml
# projects/<id>/project.yaml
egress:
  policy: allowlist
  allowlist:
    - api.github.com
\`\`\`

## Auth handoff

GitHub uses a personal-access token (\`ghp_…\`) on the
\`Authorization: Bearer <token>\` header. Read the token from the
project's API-key vault under the \`github\` slot — never inline
the literal token into a tool call or chat reply.

If the vault lookup returns no key, surface a structured error
(\`{ error: "auth_missing", connector: "github" }\`) and stop;
don't fall back to anonymous calls because rate limits + private
repos behave differently and the model would silently miss data.

## Request shape

\`\`\`http
GET https://api.github.com/search/issues?q=repo:<owner>/<repo>+is:issue+state:open
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
\`\`\`

The response paginates 30 results per page. Stop at the first page
unless the user explicitly asks for more; pulling 1000 issues into
context ruins token budget for a single answer.

## Error shapes

Always return JSON your transcript can parse cleanly:

| Upstream | Return                                                       |
|---|---|
| \`401\` / \`403\` | \`{ error: "auth_failed", connector: "github" }\` |
| \`404\` (repo) | \`{ error: "repo_not_found", repo: "<owner>/<repo>" }\` |
| \`429\` | \`{ error: "rate_limited", connector: "github", retry_after_s: <int> }\` |
| Network blocked | The egress middleware throws \`EgressBlockedError\` — surface as \`{ error: "egress_blocked", host: "api.github.com" }\` |
| Other 5xx | \`{ error: "upstream_5xx", status: <int>, connector: "github" }\` |

## Composing with kb.*

After fetching issues, write a synthesis page through
\`kb.create_page\` or \`kb.replace_block\` so the answer is
preserved across runs. Cite issue URLs in the synthesis so a human
reviewer can click through. Mark synthesised content with
\`derived_from\` pointing at the upstream URLs so the
provenance-gap lint check stays clean.
`,
  );

  // Webhook trigger — POST with optional auth, fire-and-forget.
  seedFile(
    join(sharedSkillsDir, "webhook-trigger.md"),
    `---
name: Webhook Trigger
description: Generic outbound HTTP POST for fire-and-forget integrations (Slack, Discord, n8n, Make)
---

# Webhook Trigger Skill

Use this skill when the user asks the agent to *notify* an
external system — Slack incoming-webhooks, Discord channels, an
n8n / Zapier / Make automation, a self-hosted GitHub Action
dispatcher. This is one-way: post a payload, get a status code
back, never read response bodies that could contain secrets.

## project.yaml entry

Each webhook host is allowlisted explicitly. Wildcards aren't
honored — \`hooks.slack.com\` does not unlock
\`*.slack.com\`:

\`\`\`yaml
# projects/<id>/project.yaml
egress:
  policy: allowlist
  allowlist:
    - hooks.slack.com
    - discord.com
    # ... one entry per upstream
\`\`\`

## Auth handoff

Most webhook targets bake their auth into the URL itself
(\`https://hooks.slack.com/services/T.../B.../<secret>\`). Store
the **full URL** in the project's API-key vault under a
\`webhook:<name>\` slot rather than splitting it. The agent reads
the URL via the vault primitive; the secret never appears in
chat transcripts.

For targets that use header-based auth instead, follow the
pattern in [HTTP GET with auth](http-get-with-auth.md) —
\`Authorization: Bearer\`, \`X-API-Key\`, or HMAC-signed bodies.

## Request shape

\`\`\`http
POST <vault://webhook:<name>>
Content-Type: application/json
User-Agent: Ironlore/<agent-slug>

{
  "text": "<message body>",
  "_ironlore": {
    "agent": "<slug>",
    "run_id": "<job-id>",
    "ts": "<ISO-8601>"
  }
}
\`\`\`

The \`_ironlore\` envelope is optional; many webhook receivers
ignore unknown keys, but it makes audits easier when the same
webhook fires from multiple systems.

## Error shapes

Webhook receivers vary on what they return. Treat any non-2xx as
a failed delivery and **do not retry automatically** — the run
loop's retry policy already covers transient errors, and a
duplicate Slack notification is its own incident:

| Upstream | Return                                                                |
|---|---|
| 2xx | \`{ ok: true, status: <int> }\` |
| Other | \`{ error: "webhook_failed", status: <int>, connector: "<name>" }\` |
| Network blocked | \`{ error: "egress_blocked", host: "<host>" }\` (allowlist) |

## When *not* to use this

- **Bidirectional integrations.** If the agent needs the
  upstream's response (e.g. "did the deploy succeed?"), a webhook
  is wrong — use \`http-get-with-auth\` for the read-back call.
- **Reading data.** Webhooks are write-only; don't pull GitHub
  issues through one. Use \`github-issue-search\`.
- **Bulk fan-out.** A skill posts one webhook per agent run.
  Sending 10k webhooks in a loop is a cron job, not an agent call;
  use \`ironlore eval --json\` + a shell loop instead.
`,
  );

  // Generic HTTP GET with auth — the most common pattern.
  seedFile(
    join(sharedSkillsDir, "http-get-with-auth.md"),
    `---
name: HTTP GET with auth
description: Parametric pattern for read-only HTTP GET against an authenticated upstream
---

# HTTP GET with Auth Skill

Use this skill as a template when none of the connector-specific
skills (\`github-issue-search\`, \`linear-search\`, etc.) match
your upstream. It documents the three auth shapes Ironlore
encounters in practice and the response-handling discipline that
keeps the agent's transcript safe.

## project.yaml entry

Allowlist the exact host. Sub-domains and ports must match — the
egress middleware compares against \`URL.hostname\`:

\`\`\`yaml
# projects/<id>/project.yaml
egress:
  policy: allowlist
  allowlist:
    - api.example.com
    - api-staging.example.com    # sub-domains need their own row
\`\`\`

## Auth shapes

### Bearer token (most common)

\`\`\`http
GET https://api.example.com/v1/<resource>
Authorization: Bearer <token>
Accept: application/json
\`\`\`

Vault slot: \`bearer:<service>\`. Match GitHub / Linear /
Notion / Stripe.

### API-key header

\`\`\`http
GET https://api.example.com/v1/<resource>
X-API-Key: <key>
Accept: application/json
\`\`\`

Vault slot: \`apikey:<service>\`. Match SendGrid / Datadog.

### Basic auth

\`\`\`http
GET https://api.example.com/v1/<resource>
Authorization: Basic <base64(user:password)>
Accept: application/json
\`\`\`

Vault slot: \`basic:<service>\` (store \`user:password\` raw;
encode at request time). Match older self-hosted services.

## Response handling

1. Check status. Anything \`>= 400\` returns a structured error
   (see table below); never let the model see a 500's HTML body
   verbatim — it's noise that ruins context budget.
2. Cap response size. \`Content-Length > 100 KB\` should trigger
   an \`{ error: "response_too_large" }\` rather than streaming
   into the transcript. If the user wants the full payload, write
   it to a page through \`kb.create_page\` first, then summarise.
3. Strip auth-shaped fields from any response that's about to
   land in chat. Some upstreams echo the request's
   \`Authorization\` header in error responses; redact before
   returning.

## Error shapes

| Upstream | Return                                                                |
|---|---|
| \`401\` / \`403\` | \`{ error: "auth_failed", connector: "<name>" }\` |
| \`404\` | \`{ error: "not_found", path: "<request-path>" }\` |
| \`429\` | \`{ error: "rate_limited", connector: "<name>", retry_after_s: <int> }\` |
| 5xx | \`{ error: "upstream_5xx", status: <int>, connector: "<name>" }\` |
| Network blocked | \`{ error: "egress_blocked", host: "<host>" }\` (allowlist) |
| Response too large | \`{ error: "response_too_large", limit: 102400 }\` |

## Composing with kb.*

A successful read should land in the knowledge base — not just
in the chat transcript — when the answer matters past the
current run. \`kb.create_page\` for new content,
\`kb.replace_block\` for updates to existing pages, both with
\`derived_from\` set to the upstream URL so the
provenance-gap lint check passes.
`,
  );
}

/**
 * Write a binary file only if it doesn't already exist. Non-destructive seeding.
 */
function seedBinaryFile(filePath: string, data: Uint8Array): void {
  if (existsSync(filePath)) return;
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, data);
}

/**
 * Create a minimal valid PDF that displays "Hello" on one page.
 * Hand-crafted to be self-contained (~220 bytes).
 */
function createMinimalPdf(): Uint8Array {
  const pdf = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 37>>stream
BT /F1 24 Tf 100 700 Td (Hello) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000101 00000 n
0000000196 00000 n
0000000257 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
340
%%EOF`;
  return new TextEncoder().encode(pdf);
}

/**
 * Create a 320×160 PNG with diagonal color bands — a visible placeholder
 * for the image viewer. Built from scratch via the PNG spec (IHDR + IDAT
 * + IEND) so we don't pull in an image library just for the seed.
 */
function createDemoPng(): Uint8Array {
  const width = 320;
  const height = 160;

  // Raw pixel data: each row is `\0` filter byte + RGBA bytes.
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * row;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const i = rowStart + 1 + x * 4;
      const t = (x + y) / (width + height);
      raw[i] = Math.round(59 + (239 - 59) * t); // R
      raw[i + 1] = Math.round(130 + (68 - 130) * t); // G
      raw[i + 2] = Math.round(246 + (68 - 246) * t); // B
      raw[i + 3] = 255; // A
    }
  }

  const compressed = deflateRawSync(raw);
  // PNG IDAT wants zlib-framed data; `deflateRawSync` returns raw DEFLATE.
  // We prepend a 2-byte zlib header and append the Adler-32 checksum.
  const zlibHeader = Buffer.from([0x78, 0x9c]);
  const adler = adler32(raw);
  const adlerBytes = Buffer.from([
    (adler >>> 24) & 0xff,
    (adler >>> 16) & 0xff,
    (adler >>> 8) & 0xff,
    adler & 0xff,
  ]);
  const idatData = Buffer.concat([zlibHeader, compressed, adlerBytes]);

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk(
    "IHDR",
    (() => {
      const b = Buffer.alloc(13);
      b.writeUInt32BE(width, 0);
      b.writeUInt32BE(height, 4);
      b[8] = 8; // bit depth
      b[9] = 6; // color type: RGBA
      b[10] = 0; // compression
      b[11] = 0; // filter
      b[12] = 0; // interlace
      return b;
    })(),
  );
  const idat = pngChunk("IDAT", idatData);
  const iend = pngChunk("IEND", Buffer.alloc(0));

  return new Uint8Array(Buffer.concat([sig, ihdr, idat, iend]));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + (buf[i] ?? 0)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}
