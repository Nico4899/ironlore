import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * `ironlore lint --check provenance` — find agent-authored blocks
 * shipped without `derived_from` source citations.
 *
 * Per docs/02-storage-and-sync.md table at lines 78-84, the
 * `provenance` category covers dangling `source_ids` and empty
 * `derived_from` on agent-stamped blocks. This implementation
 * mirrors the logic in
 * `apps/web/src/server/tools/kb-lint-provenance-gaps.ts` (which
 * powers the wiki-gardener's same check) — the CLI must not depend
 * on the web server, so the helpers live here verbatim.
 *
 * Detection rule: a block is a "gap" iff
 *   1. `agent` is set in `.blocks.json` (= block was authored by an
 *      agent run, not a human edit through the pages-api), AND
 *   2. `derived_from` is missing or empty (= the agent didn't cite
 *      any source blocks).
 *
 * Read-only. `--fix` is informational here — auto-stamping derived_from
 * would invent citations the agent never made (per doc line 84).
 */

interface LintProvenanceOptions {
  project: string;
  /** No-op for this category — surface findings only. */
  fix?: boolean;
  /**
   * Override the working directory root. Defaults to `process.cwd()`.
   * The project resolves as `<cwd>/projects/<project>`.
   */
  cwd?: string;
}

interface SidecarBlock {
  id: string;
  type?: string;
  agent?: string;
  derived_from?: string[];
  compiled_at?: string;
}

interface SidecarIndex {
  version: number;
  blocks: SidecarBlock[];
}

interface ProvenanceGap {
  pagePath: string;
  blockId: string;
  agent: string;
  compiledAt: string | null;
}

/**
 * Mirror of kb-lint-provenance-gaps.ts:walkSidecars. Recursive walk
 * picks up every `*.blocks.json` under dataRoot, skipping `.ironlore/`
 * (derived state) and `.agents/` (agent-internal scaffolding). Both
 * use the dotfile prefix so a single check skips them.
 */
function walkSidecars(dataRoot: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dataRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (entry.endsWith(".blocks.json")) {
        out.push(full);
      }
    }
  }
  return out;
}

function gapsForSidecar(
  pagePath: string,
  index: SidecarIndex,
  excludeAgents: Set<string>,
): ProvenanceGap[] {
  const gaps: ProvenanceGap[] = [];
  for (const block of index.blocks) {
    if (!block.agent) continue;
    if (excludeAgents.has(block.agent)) continue;
    const cited = Array.isArray(block.derived_from) && block.derived_from.length > 0;
    if (cited) continue;
    gaps.push({
      pagePath,
      blockId: block.id,
      agent: block.agent,
      compiledAt: block.compiled_at ?? null,
    });
  }
  return gaps;
}

export function lintProvenance(opts: LintProvenanceOptions): void {
  const baseCwd = opts.cwd ?? process.cwd();
  const projectDir = join(baseCwd, "projects", opts.project);
  const dataRoot = join(projectDir, "data");

  if (!existsSync(dataRoot)) {
    console.log(`    No data root at ${dataRoot} — nothing to check.`);
    return;
  }

  const sidecarPaths = walkSidecars(dataRoot);
  const gaps: ProvenanceGap[] = [];

  for (const sidecarPath of sidecarPaths) {
    const mdPath = sidecarPath.replace(/\.blocks\.json$/, ".md");
    const relPath = relative(dataRoot, mdPath).split(sep).join("/");
    let index: SidecarIndex;
    try {
      const raw = readFileSync(sidecarPath, "utf-8");
      index = JSON.parse(raw) as SidecarIndex;
    } catch {
      // Malformed sidecar — skip rather than fail the whole lint.
      continue;
    }
    if (!index.blocks || !Array.isArray(index.blocks)) continue;
    gaps.push(...gapsForSidecar(relPath, index, new Set()));
  }

  if (gaps.length === 0) {
    console.log("    Provenance clean — every agent-authored block cites at least one source.");
    return;
  }

  // Group by page so the output stays readable for vaults with many
  // gaps on the same page.
  const byPage = new Map<string, ProvenanceGap[]>();
  for (const g of gaps) {
    const bucket = byPage.get(g.pagePath);
    if (bucket) bucket.push(g);
    else byPage.set(g.pagePath, [g]);
  }

  console.log(
    `    ${gaps.length} provenance gap${gaps.length === 1 ? "" : "s"} across ${byPage.size} page${byPage.size === 1 ? "" : "s"}:`,
  );
  const pageList = [...byPage.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const displayPages = pageList.slice(0, 20);
  for (const [page, pageGaps] of displayPages) {
    console.log(`      ${page}`);
    const displayGaps = pageGaps.slice(0, 5);
    for (const g of displayGaps) {
      console.log(
        `        ${g.blockId}  agent=${g.agent}  ${g.compiledAt ? `(${g.compiledAt})` : "(no timestamp)"}`,
      );
    }
    if (pageGaps.length > displayGaps.length) {
      console.log(`        …and ${pageGaps.length - displayGaps.length} more block(s)`);
    }
  }
  if (pageList.length > displayPages.length) {
    console.log(`      …and ${pageList.length - displayPages.length} more page(s)`);
  }

  if (opts.fix) {
    console.log(
      "    (--fix is informational for provenance — auto-stamping derived_from would invent citations the agent never made.)",
    );
  }
}
