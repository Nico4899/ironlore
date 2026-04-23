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

Dozens of specialist personas live in \`.agents/.library/\` as inactive
templates — Product Manager, Technical Writer, SEO Specialist, Wiki
Gardener, and more. Activate one by flipping \`active: true\` in its
frontmatter. Each specialist has a scheduled heartbeat (cron) and a scope
that limits which folders it can read or write.

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

  // General agent (seeded, not deletable)
  seedFile(
    join(dataDir, AGENTS_DIR, "general", "persona.md"),
    `---
name: General
slug: general
emoji: "\u{1F4AC}"
type: default
role: "Knowledge base assistant — read-mostly, citation-grounded answers"
provider: anthropic
active: true
scope:
  pages: ["/**"]
  writable_kinds: []
---

You are the General assistant for this Ironlore knowledge base. Your role is
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
    {
      slug: "ceo",
      name: "CEO",
      emoji: "\u{1F451}",
      dept: "Executive",
      role: "Strategic direction, weekly priorities, decision log",
      heartbeat: "0 8 * * 1",
      scope: "/strategy/**",
    },
    {
      slug: "content-marketer",
      name: "Content Marketer",
      emoji: "\u{270D}\u{FE0F}",
      dept: "Marketing",
      role: "Blog posts, guides, thought leadership",
      heartbeat: "0 9 * * 1-5",
      scope: "/marketing/**",
    },
    {
      slug: "social-media-manager",
      name: "Social Media Manager",
      emoji: "\u{1F4F1}",
      dept: "Marketing",
      role: "Social posts, engagement tracking, trend analysis",
      heartbeat: "0 10 * * 1-5",
      scope: "/social/**",
    },
    {
      slug: "seo-specialist",
      name: "SEO Specialist",
      emoji: "\u{1F50D}",
      dept: "Marketing",
      role: "Keyword research, content optimization, rank tracking",
      heartbeat: "0 9 * * 1,4",
      scope: "/seo/**",
    },
    {
      slug: "product-manager",
      name: "Product Manager",
      emoji: "\u{1F4CB}",
      dept: "Product",
      role: "Feature specs, roadmap updates, user feedback synthesis",
      heartbeat: "0 9 * * 1-5",
      scope: "/product/**",
    },
    {
      slug: "ux-researcher",
      name: "UX Researcher",
      emoji: "\u{1F9EA}",
      dept: "Product",
      role: "User interviews, usability findings, persona updates",
      heartbeat: "0 10 * * 2,4",
      scope: "/research/**",
    },
    {
      slug: "developer-advocate",
      name: "Developer Advocate",
      emoji: "\u{1F4E3}",
      dept: "Engineering",
      role: "Technical tutorials, API docs, community engagement",
      heartbeat: "0 9 * * 1-5",
      scope: "/devrel/**",
    },
    {
      slug: "technical-writer",
      name: "Technical Writer",
      emoji: "\u{1F4DD}",
      dept: "Engineering",
      role: "Documentation, API references, changelogs",
      heartbeat: "0 9 * * 1-5",
      scope: "/docs/**",
    },
    {
      slug: "data-analyst",
      name: "Data Analyst",
      emoji: "\u{1F4CA}",
      dept: "Analytics",
      role: "Metrics dashboards, trend reports, cohort analysis",
      heartbeat: "0 8 * * 1",
      scope: "/analytics/**",
    },
    {
      slug: "sales-enablement",
      name: "Sales Enablement",
      emoji: "\u{1F4BC}",
      dept: "Sales",
      role: "Battle cards, objection handling, case studies",
      heartbeat: "0 9 * * 1,3,5",
      scope: "/sales/**",
    },
    {
      slug: "customer-success",
      name: "Customer Success",
      emoji: "\u{1F91D}",
      dept: "Support",
      role: "FAQ maintenance, onboarding guides, health scores",
      heartbeat: "0 9 * * 1-5",
      scope: "/support/**",
    },
    {
      slug: "recruiter",
      name: "Recruiter",
      emoji: "\u{1F465}",
      dept: "People",
      role: "Job descriptions, candidate pipelines, interview guides",
      heartbeat: "0 9 * * 1,3",
      scope: "/people/**",
    },
    {
      slug: "legal-analyst",
      name: "Legal Analyst",
      emoji: "\u{2696}\u{FE0F}",
      dept: "Legal",
      role: "Policy summaries, compliance tracking, contract templates",
      heartbeat: "0 9 * * 1",
      scope: "/legal/**",
    },
    {
      slug: "finance-analyst",
      name: "Finance Analyst",
      emoji: "\u{1F4B0}",
      dept: "Finance",
      role: "Budget tracking, forecast models, expense reports",
      heartbeat: "0 8 * * 1",
      scope: "/finance/**",
    },
    {
      slug: "competitive-intel",
      name: "Competitive Intelligence",
      emoji: "\u{1F50E}",
      dept: "Strategy",
      role: "Competitor tracking, market landscape, SWOT analysis",
      heartbeat: "0 9 * * 1,4",
      scope: "/competitive/**",
    },
    {
      slug: "brand-strategist",
      name: "Brand Strategist",
      emoji: "\u{1F3A8}",
      dept: "Marketing",
      role: "Brand guidelines, messaging frameworks, visual identity",
      heartbeat: "0 10 * * 1",
      scope: "/brand/**",
    },
    {
      slug: "newsletter-editor",
      name: "Newsletter Editor",
      emoji: "\u{1F4E8}",
      dept: "Marketing",
      role: "Newsletter drafts, subscriber segmentation, A/B tests",
      heartbeat: "0 9 * * 2,4",
      scope: "/newsletter/**",
    },
    {
      slug: "partnerships-manager",
      name: "Partnerships Manager",
      emoji: "\u{1F91D}",
      dept: "Business Dev",
      role: "Partner profiles, integration opportunities, co-marketing",
      heartbeat: "0 9 * * 1,3",
      scope: "/partnerships/**",
    },
    {
      slug: "community-manager",
      name: "Community Manager",
      emoji: "\u{1F30D}",
      dept: "Community",
      role: "Community health, event planning, contributor recognition",
      heartbeat: "0 10 * * 1-5",
      scope: "/community/**",
    },
    {
      slug: "wiki-gardener",
      name: "Wiki Gardener",
      emoji: "\u{1F33F}",
      dept: "Maintenance",
      role: "Wiki health — orphan detection, stale pages, link rot",
      heartbeat: "0 6 * * 0",
      scope: "/**",
    },
  ];

  for (const p of personas) {
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
active: false
scope:
  pages: ["${p.scope}"]
  tags: []
  writable_kinds: [page, wiki]
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
        : `
You are {{company_name}}'s ${p.name}. Company description: {{company_description}}.
Current goals: {{goals}}.

## Responsibilities

${p.role}.

## Guidelines

- Work within your assigned scope: \`${p.scope}\`
- Use structured kb.* tools for all edits
- File a journal entry at the end of each run
- Respect page kinds: never modify \`kind: source\` pages
`;

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
description: Wiki health check — orphans, stale sources, contradiction flags, provenance gaps
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

## The four checks

### 1. Orphans — pages with zero inbound wiki-links

Real check. Call \`kb.search\` with an empty-ish query to enumerate
pages, then for each candidate check whether any other page links to it
via \`[[page]]\` syntax. Skip pages with \`kind: source\` (sources are
expected to be inbound-only) and any page in the \`_maintenance/\` or
\`getting-started/\` folders (self-documentation).

Report each orphan as a row: \`| path | kind | last-modified |\`.

### 2. Stale sources — wiki pages older than their cited sources

Stub check. The infrastructure to compare source-page \`modified\`
timestamps against the wiki pages that cite them is not yet wired up
(tracked in the Phase 11 roadmap). For now, produce a stub section with
a one-line note so the report shape stays stable across releases. Do
**not** hallucinate findings.

### 3. Contradiction flags — peer claims that disagree

Stub check. \`kb.check_contradictions\` is scheduled for a later phase.
Produce the stub section exactly like §2 above; do not invent
contradictions.

### 4. Provenance gaps — agent-authored blocks missing \`derived_from\`

Stub check. \`.blocks.json\` sidecars do not yet carry the
\`derived_from\` field in their schema. Produce the stub section; do
not flag blocks without real evidence.

## Report output

Write **exactly one** page at \`_maintenance/lint-<YYYY-MM-DD>.md\` with
frontmatter \`kind: wiki\`, \`created\` = today's ISO date. Structure:

\`\`\`markdown
# Lint report — <YYYY-MM-DD>

## Summary
- Orphans: N
- Stale sources: — (detector not yet available)
- Contradiction flags: — (detector not yet available)
- Provenance gaps: — (detector not yet available)

## Orphans
<table of orphan rows or "None.">

## Stale sources
_Detector not yet available — tracked in Phase 11 roadmap._

## Contradiction flags
_Detector not yet available — tracked in Phase 11 roadmap._

## Provenance gaps
_Detector not yet available — tracked in Phase 11 roadmap._
\`\`\`

After writing the report, append a one-line entry to \`_log.md\`:
\`- <ISO timestamp> · lint · <N> orphans · [[_maintenance/lint-<date>]]\`.
Then add a backlink entry in \`_index.md\` under a "Maintenance" heading
if the heading exists, otherwise create it.

Close the run with \`agent.journal\` summarising counts and the report
path.
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
