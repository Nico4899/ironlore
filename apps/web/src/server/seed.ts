import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "@ironlore/core";

/**
 * Write a file only if it doesn't already exist. Non-destructive seeding.
 */
function seedFile(filePath: string, content: string): void {
  if (existsSync(filePath)) return;
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}

/**
 * Seed the data directory on first run.
 *
 * Creates getting-started content, CLAUDE.md, agent library personas,
 * and the Carousel Factory example workspace. Skips any file that
 * already exists.
 */
export async function seed(dataDir: string): Promise<void> {
  // -------------------------------------------------------------------------
  // Getting Started
  // -------------------------------------------------------------------------
  seedFile(
    join(dataDir, "getting-started", "index.md"),
    `---
schema: 1
id: ${ulid()}
title: Getting Started
kind: page
created: ${new Date().toISOString()}
modified: ${new Date().toISOString()}
tags: [onboarding]
icon: lucide:rocket
---

# Getting Started with Ironlore

Welcome to your knowledge base. Ironlore is a self-hosted, AI-native system
where you and your AI agents share the same markdown files.

## Core concepts

- **Pages** are markdown files on disk. Everything you see is a file you own.
- **Agents** are AI assistants that can read and edit your knowledge base
  through structured tools — never raw file writes.
- **The filesystem is the product.** If Ironlore stops running, your data is
  still plain markdown in a git repo.

## Quick start

1. Create a new page using the sidebar
2. Write some notes in markdown
3. Open the AI panel (\`Cmd+Shift+A\`) to ask questions about your content
4. Your content auto-saves with conflict detection

## Next steps

- Explore the example content in the Carousel Factory workspace
- Set up your first AI agent from the agent library
- Read the [documentation](https://github.com/ironlore/ironlore) for more details
`,
  );

  // -------------------------------------------------------------------------
  // Root index page
  // -------------------------------------------------------------------------
  seedFile(
    join(dataDir, "index.md"),
    `---
schema: 1
id: ${ulid()}
title: Home
kind: page
created: ${new Date().toISOString()}
modified: ${new Date().toISOString()}
icon: lucide:home
---

# Welcome to Ironlore

Your self-hosted knowledge base with AI agents that remember everything.

Start by exploring the [Getting Started](getting-started) guide.
`,
  );

  // -------------------------------------------------------------------------
  // CLAUDE.md — project context for AI agents
  // -------------------------------------------------------------------------
  seedFile(
    join(dataDir, "CLAUDE.md"),
    `# Ironlore Knowledge Base

This is an Ironlore knowledge base. The data directory contains markdown
files organized in a flat-to-nested hierarchy.

## Conventions

- Pages use YAML frontmatter with \`schema: 1\`
- Every page has a ULID \`id\` that survives renames and moves
- Page kinds: \`page\` (default), \`source\` (immutable raw), \`wiki\` (agent-maintained)
- Block IDs in HTML comments (\`<!-- #blk_... -->\`) are stable edit targets
- Assets live in \`<page>/assets/\`, scoped to their parent page

## Agent rules

- Never write files directly — use \`kb.*\` structured tools
- Every mutation must carry an ETag from the last read
- \`kind: source\` pages are read-only to agents
- Respect the scope defined in your persona.md
`,
  );

  // -------------------------------------------------------------------------
  // Carousel Factory example workspace
  // -------------------------------------------------------------------------
  seedFile(
    join(dataDir, "carousel-factory", "index.md"),
    `---
schema: 1
id: ${ulid()}
title: Carousel Factory
kind: page
created: ${new Date().toISOString()}
modified: ${new Date().toISOString()}
tags: [example, marketing]
icon: lucide:image
---

# Carousel Factory

An example workspace demonstrating how Ironlore organizes content for a
marketing team producing social media carousels.

## Structure

- **brand-voice/** — tone, vocabulary, and style guidelines
- **templates/** — reusable carousel templates
- **drafts/** — work in progress
- **published/** — final versions with performance data

This workspace shows how agents and humans collaborate on content production.
`,
  );

  seedFile(
    join(dataDir, "carousel-factory", "brand-voice", "index.md"),
    `---
schema: 1
id: ${ulid()}
title: Brand Voice
kind: source
created: ${new Date().toISOString()}
modified: ${new Date().toISOString()}
tags: [brand, guidelines]
icon: lucide:megaphone
---

# Brand Voice Guidelines

## Tone

- Confident but not arrogant
- Technical but accessible
- Concise — every word earns its place

## Vocabulary

- Use "knowledge base" not "wiki" or "database"
- Use "agent" not "bot" or "assistant"
- Use "page" not "document" or "file" (in user-facing copy)

## Formatting

- Headlines: sentence case, no periods
- Paragraphs: 2-3 sentences max
- Lists: parallel construction, no trailing punctuation
`,
  );

  // -------------------------------------------------------------------------
  // Agent library personas
  // -------------------------------------------------------------------------
  const agentLibDir = join(dataDir, ".agents", ".library");
  const sharedSkillsDir = join(dataDir, ".agents", ".shared", "skills");
  mkdirSync(agentLibDir, { recursive: true });
  mkdirSync(sharedSkillsDir, { recursive: true });

  // General agent (seeded, not deletable)
  seedFile(
    join(dataDir, ".agents", "general", "persona.md"),
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
    join(dataDir, ".agents", "editor", "persona.md"),
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
