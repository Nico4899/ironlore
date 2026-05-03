import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * `ironlore lint --check structure` — surface structural anomalies
 * in the project's content tree.
 *
 * Per docs/02-storage-and-sync.md table at lines 78-84, the
 * `structure` category covers:
 *   - **Orphan pages**: markdown files with zero inbound wiki-links.
 *   - **Coverage gaps**: wiki-link targets cited by ≥3 distinct pages
 *     that don't resolve to any existing page (default per
 *     Phase-11 lint spec — single stray references read as typos).
 *
 * Mirrors the SQL in `apps/web/src/server/search-index.ts`
 * `findOrphans` / `findCoverageGaps` so the CLI can run without
 * spinning up the server. The CLI must not depend on the web app
 * (separation of concerns) — so the helpers live here verbatim.
 *
 * Read-only. `--fix` is informational here — auto-creating empty
 * pages or auto-deleting orphans both have worse failure modes than
 * surfacing the findings for human/agent review (per doc line 84).
 */

interface LintStructureOptions {
  project: string;
  /** No-op for this category — surface findings only. */
  fix?: boolean;
  /**
   * Override the working directory root. Defaults to `process.cwd()`.
   * The project resolves as `<cwd>/projects/<project>`.
   */
  cwd?: string;
}

const DEFAULT_EXCLUDE_PREFIXES = ["_maintenance/", "getting-started/", ".agents/"] as const;

/** Mirror of search-index.ts:1473 — every spelling that resolves a page. */
function linkTargetCandidates(pagePath: string): string[] {
  const noExt = pagePath.replace(/\.md$/, "");
  const slashIdx = noExt.lastIndexOf("/");
  const basename = slashIdx === -1 ? noExt : noExt.slice(slashIdx + 1);
  return [
    ...new Set<string>([
      pagePath,
      noExt,
      basename,
      pagePath.toLowerCase(),
      noExt.toLowerCase(),
      basename.toLowerCase(),
    ]),
  ];
}

/** Mirror of search-index.ts:1494 — case-insensitive normalization. */
function linkLookupKey(target: string): string {
  return target.toLowerCase();
}

interface OrphanRow {
  path: string;
  updatedAt: string;
}

interface CoverageGapRow {
  target: string;
  citationCount: number;
}

function findOrphans(db: Database.Database): OrphanRow[] {
  const pages = db
    .prepare("SELECT path, updated_at AS updatedAt FROM pages WHERE file_type = 'markdown'")
    .all() as OrphanRow[];

  const targetRows = db
    .prepare("SELECT DISTINCT target_path AS target FROM backlinks")
    .all() as Array<{ target: string }>;

  const targetsLc = new Set<string>();
  for (const t of targetRows) targetsLc.add(linkLookupKey(t.target));

  const out: OrphanRow[] = [];
  for (const page of pages) {
    if (DEFAULT_EXCLUDE_PREFIXES.some((pre) => page.path.startsWith(pre))) continue;
    const candidates = linkTargetCandidates(page.path);
    const linked = candidates.some((c) => targetsLc.has(linkLookupKey(c)));
    if (!linked) out.push(page);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function findCoverageGaps(db: Database.Database, minMentions = 3): CoverageGapRow[] {
  const pages = db.prepare("SELECT path FROM pages WHERE file_type = 'markdown'").all() as Array<{
    path: string;
  }>;
  const resolved = new Set<string>();
  for (const p of pages) {
    for (const c of linkTargetCandidates(p.path)) resolved.add(linkLookupKey(c));
  }

  const rows = db
    .prepare("SELECT target_path AS target, source_path AS source FROM backlinks")
    .all() as Array<{ target: string; source: string }>;

  const grouped = new Map<string, Set<string>>();
  for (const r of rows) {
    if (DEFAULT_EXCLUDE_PREFIXES.some((pre) => r.source.startsWith(pre))) continue;
    if (resolved.has(linkLookupKey(r.target))) continue;
    let bucket = grouped.get(r.target);
    if (!bucket) {
      bucket = new Set();
      grouped.set(r.target, bucket);
    }
    bucket.add(r.source);
  }

  const out: CoverageGapRow[] = [];
  for (const [target, sources] of grouped) {
    if (sources.size < minMentions) continue;
    out.push({ target, citationCount: sources.size });
  }
  out.sort((a, b) => b.citationCount - a.citationCount);
  return out;
}

export function lintStructure(opts: LintStructureOptions): void {
  const baseCwd = opts.cwd ?? process.cwd();
  const projectDir = join(baseCwd, "projects", opts.project);
  const indexPath = join(projectDir, ".ironlore", "index.sqlite");

  if (!existsSync(indexPath)) {
    console.log("    No index found. Run 'ironlore lint --fix --check index-consistency' first.");
    return;
  }

  const db = new Database(indexPath, { readonly: true });
  try {
    const orphans = findOrphans(db);
    const gaps = findCoverageGaps(db);

    if (orphans.length === 0 && gaps.length === 0) {
      console.log("    Structure clean — no orphans, no coverage gaps.");
      return;
    }

    if (orphans.length > 0) {
      console.log(`    Orphans (${orphans.length}):`);
      const display = orphans.slice(0, 20);
      for (const o of display) {
        console.log(`      ${o.path}  (updated ${o.updatedAt})`);
      }
      if (orphans.length > display.length) {
        console.log(`      …and ${orphans.length - display.length} more`);
      }
    }

    if (gaps.length > 0) {
      console.log(`    Coverage gaps (${gaps.length}):`);
      const display = gaps.slice(0, 20);
      for (const g of display) {
        console.log(`      [[${g.target}]]  ×${g.citationCount} citation(s)`);
      }
      if (gaps.length > display.length) {
        console.log(`      …and ${gaps.length - display.length} more`);
      }
    }

    if (opts.fix) {
      console.log(
        "    (--fix is informational for structure — surfacing only; auto-fix would risk silent edits.)",
      );
    }
  } finally {
    db.close();
  }
}
