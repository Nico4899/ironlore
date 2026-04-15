import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GenerateLargeKbOptions {
  /** Target page count. The generator emits exactly this many markdown files. */
  count: number;
  /** Destination `data/` root. Created if missing. */
  dataRoot: string;
  /** Optional deterministic seed for repeatable fixtures. Defaults to 1. */
  seed?: number;
  /** Approximate nodes per directory before a new one spawns. Default 50. */
  fanout?: number;
}

const LOREM = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "magna",
  "aliqua",
  "enim",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
];

const TAG_POOL = [
  "planning",
  "research",
  "draft",
  "meeting",
  "retro",
  "review",
  "design",
  "bug",
  "infra",
  "product",
];

/**
 * Deterministic mulberry32 PRNG — seed-stable across platforms so fixture
 * output matches bit-for-bit between runs.
 */
function rng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)] as T;
}

function pageBody(rand: () => number, index: number, totalPages: number): string {
  const wordCount = 60 + Math.floor(rand() * 180);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(pick(rand, LOREM));

  const tagCount = 1 + Math.floor(rand() * 3);
  const tags = new Set<string>();
  while (tags.size < tagCount) tags.add(pick(rand, TAG_POOL));

  const linkCount = 1 + Math.floor(rand() * 4);
  const links: string[] = [];
  for (let i = 0; i < linkCount; i++) {
    const target = Math.floor(rand() * totalPages);
    if (target !== index) links.push(`page-${target.toString().padStart(4, "0")}`);
  }

  return [
    "---",
    `title: Page ${index}`,
    `tags: [${[...tags].join(", ")}]`,
    "---",
    "",
    `# Page ${index}`,
    "",
    words.join(" "),
    "",
    "## Related",
    "",
    ...links.map((l) => `- [[${l}]]`),
    "",
  ].join("\n");
}

/**
 * Materialize an N-page synthetic KB under `dataRoot`. Used by the Phase 3
 * sidebar/search benchmarks and by any test that needs a non-trivial corpus.
 *
 * Output:
 *   data/page-0000.md
 *   data/folder-00/page-0050.md
 *   data/folder-00/page-0051.md
 *   ...
 *
 * Content is deterministic given a seed and `count`. Wiki-links point at
 * other page IDs in the set so the backlinks table gets a realistic shape.
 */
export function generateLargeKb(opts: GenerateLargeKbOptions): { written: number } {
  const { count, dataRoot, seed = 1, fanout = 50 } = opts;
  const rand = rng(seed);

  mkdirSync(dataRoot, { recursive: true });

  let written = 0;
  for (let i = 0; i < count; i++) {
    const folderIdx = Math.floor(i / fanout);
    const folderName = folderIdx === 0 ? "" : `folder-${folderIdx.toString().padStart(2, "0")}`;
    const dir = folderName ? join(dataRoot, folderName) : dataRoot;
    if (folderName) mkdirSync(dir, { recursive: true });

    const filename = `page-${i.toString().padStart(4, "0")}.md`;
    writeFileSync(join(dir, filename), pageBody(rand, i, count));
    written++;
  }

  return { written };
}
