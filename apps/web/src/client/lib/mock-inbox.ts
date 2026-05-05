import type { InboxFileDiff } from "./api.js";

/**
 * Visual-test fixtures for the Sidebar's Inbox tab. Injected by
 * `InboxPanel` only when `import.meta.env.DEV === true` AND the real
 * fetch returned zero entries — so production installs never see
 * mock content, but a dev with no live runs still gets a populated
 * panel to inspect each rendering case.
 *
 * Cases covered:
 *   1. Just-finished, single-file edit (most recent timestamp).
 *   2. A few minutes old, mixed add/modify across three files.
 *   3. A couple of hours old, busy 6-file batch.
 *   4. Yesterday, partial review state — one file approved, one rejected.
 *   5. Several days old, includes a deletion + binary placeholder.
 */

export interface MockInboxEntry {
  id: string;
  agentSlug: string;
  branch: string;
  jobId: string;
  filesChanged: string[];
  finalizedAt: number;
  status: string;
}

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const MOCK_INBOX_ENTRIES: MockInboxEntry[] = [
  {
    id: "mock-just-now",
    agentSlug: "editor",
    branch: "agents/editor/j-001",
    jobId: "j-001",
    filesChanged: ["docs/api-reference.md"],
    finalizedAt: NOW - 30_000,
    status: "pending",
  },
  {
    id: "mock-five-min",
    agentSlug: "researcher",
    branch: "agents/researcher/j-002",
    jobId: "j-002",
    filesChanged: ["docs/architecture.md", "notes/january-meeting.md", "research/deep-learning.md"],
    finalizedAt: NOW - 5 * MIN,
    status: "pending",
  },
  {
    id: "mock-two-hours",
    agentSlug: "summarizer",
    branch: "agents/summarizer/j-003",
    jobId: "j-003",
    filesChanged: [
      "docs/01-overview.md",
      "docs/02-storage-and-sync.md",
      "docs/03-editor.md",
      "docs/04-ai-and-agents.md",
      "docs/05-search.md",
      "docs/index.md",
    ],
    finalizedAt: NOW - 2 * HOUR,
    status: "pending",
  },
  {
    id: "mock-yesterday",
    agentSlug: "linter",
    branch: "agents/linter/j-004",
    jobId: "j-004",
    filesChanged: ["packages/core/src/types.ts", "packages/core/src/index.ts"],
    finalizedAt: NOW - 1 * DAY,
    status: "pending",
  },
  {
    id: "mock-three-days",
    agentSlug: "fact-checker",
    branch: "agents/fact-checker/j-005",
    jobId: "j-005",
    filesChanged: [
      "research/quantum-computing.md",
      "research/machine-learning-survey.md",
      "research/figures/diagram.png",
    ],
    finalizedAt: NOW - 3 * DAY,
    status: "pending",
  },
];

/**
 * Pre-baked per-entry file diff stats so the cards render with their
 * `A/D/M path +N -M` rows immediately — no network round-trip
 * needed and no failure flicker for IDs that don't exist server-side.
 */
export const MOCK_INBOX_FILES: ReadonlyMap<string, InboxFileDiff[]> = new Map([
  [
    "mock-just-now",
    [{ path: "docs/api-reference.md", status: "M", added: 12, removed: 3, decision: null }],
  ],
  [
    "mock-five-min",
    [
      { path: "docs/architecture.md", status: "M", added: 25, removed: 8, decision: null },
      { path: "notes/january-meeting.md", status: "A", added: 47, removed: 0, decision: null },
      { path: "research/deep-learning.md", status: "M", added: 91, removed: 15, decision: null },
    ],
  ],
  [
    "mock-two-hours",
    [
      { path: "docs/01-overview.md", status: "M", added: 4, removed: 12, decision: null },
      { path: "docs/02-storage-and-sync.md", status: "M", added: 18, removed: 22, decision: null },
      { path: "docs/03-editor.md", status: "M", added: 7, removed: 6, decision: null },
      { path: "docs/04-ai-and-agents.md", status: "M", added: 33, removed: 9, decision: null },
      { path: "docs/05-search.md", status: "M", added: 14, removed: 11, decision: null },
      { path: "docs/index.md", status: "M", added: 2, removed: 1, decision: null },
    ],
  ],
  [
    // Demonstrates the partial-review state: per-file decisions
    //  recorded but the entry itself isn't yet approved/rejected as
    //  a whole.
    "mock-yesterday",
    [
      {
        path: "packages/core/src/types.ts",
        status: "M",
        added: 6,
        removed: 0,
        decision: "approved",
      },
      {
        path: "packages/core/src/index.ts",
        status: "M",
        added: 1,
        removed: 0,
        decision: "rejected",
      },
    ],
  ],
  [
    "mock-three-days",
    [
      {
        path: "research/quantum-computing.md",
        status: "M",
        added: 156,
        removed: 23,
        decision: null,
      },
      {
        path: "research/machine-learning-survey.md",
        status: "D",
        added: null,
        removed: null,
        decision: null,
      },
      // Binary file → both `added` and `removed` are null.
      {
        path: "research/figures/diagram.png",
        status: "A",
        added: null,
        removed: null,
        decision: null,
      },
    ],
  ],
]);

export function isMockInboxId(id: string): boolean {
  return id.startsWith("mock-");
}
