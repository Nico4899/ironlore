import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
- \`slide.pdf\` — paginated PDF with zoom
- \`photo.png\` — zoomable image viewer

Every other file type in the content model works the same way — drop a
\`.docx\`, \`.xlsx\`, \`.mp4\`, \`.vtt\`, or \`.eml\` into any folder and it
opens in a dedicated viewer.
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
  seedBinaryFile(join(dataDir, "carousel", "photo.png"), createMinimalPng());

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
    seedFile(
      join(agentLibDir, `${p.slug}.md`),
      `---
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
---

You are {{company_name}}'s ${p.name}. Company description: {{company_description}}.
Current goals: {{goals}}.

## Responsibilities

${p.role}.

## Guidelines

- Work within your assigned scope: \`${p.scope}\`
- Use structured kb.* tools for all edits
- File a journal entry at the end of each run
- Respect page kinds: never modify \`kind: source\` pages
`,
    );
  }

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
 * Create a minimal 1x1 red PNG image.
 */
function createMinimalPng(): Uint8Array {
  // Pre-computed minimal PNG: 1x1 pixel, red (#FF0000)
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // PNG signature
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52, // IHDR chunk
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    0x08,
    0x02,
    0x00,
    0x00,
    0x00,
    0x90,
    0x77,
    0x53,
    0xde,
    0x00,
    0x00,
    0x00,
    0x0c,
    0x49,
    0x44,
    0x41,
    0x54, // IDAT chunk
    0x08,
    0xd7,
    0x63,
    0xf8,
    0xcf,
    0xc0,
    0x00,
    0x00,
    0x00,
    0x02,
    0x00,
    0x01,
    0xe2,
    0x21,
    0xbc,
    0x33,
    0x00,
    0x00,
    0x00,
    0x00,
    0x49,
    0x45,
    0x4e,
    0x44, // IEND chunk
    0xae,
    0x42,
    0x60,
    0x82,
  ]);
}
