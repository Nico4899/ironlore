import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * `ironlore eval` — read-only perf + quality scorecard for a project.
 *
 * Runs against a project directory, never modifies data. Produces:
 *   - Perf scorecard: FTS5 latency, sidebar load time, write throughput.
 *   - Quality scorecard: wiki-link integrity, orphan pages, block-ID
 *     coverage, provenance completeness.
 *
 * Use `--json` for machine-readable output, `--perf-only` / `--quality-only`
 * to scope. Exit code 0 = pass, 1 = issues found.
 *
 * See docs/06-implementation-roadmap.md Phase 4 and docs/04-ai-and-agents.md
 * §Retrieval pipeline.
 */

interface EvalOptions {
  project: string;
  json: boolean;
  perfOnly: boolean;
  qualityOnly: boolean;
  /**
   * Override the working directory root. Defaults to `process.cwd()`.
   * The project is resolved as `<cwd>/projects/<project>` — exposing
   * cwd lets tests run against a tempdir without mutating global state.
   */
  cwd?: string;
}

export async function evalCommand(opts: EvalOptions): Promise<void> {
  const baseCwd = opts.cwd ?? process.cwd();
  const projectDir = join(baseCwd, "projects", opts.project);
  const dataRoot = join(projectDir, "data");
  const indexPath = join(projectDir, ".ironlore", "index.sqlite");

  if (!existsSync(indexPath)) {
    console.error(
      `No index found at ${indexPath}. Run 'ironlore lint --fix --check index-consistency' first.`,
    );
    process.exit(1);
  }

  const db = new Database(indexPath, { readonly: true });
  db.pragma("journal_mode = WAL");

  const report: Record<string, unknown> = {
    project: opts.project,
    path: projectDir,
    timestamp: new Date().toISOString(),
  };

  // ─── Dataset stats ─────────────────────────────────────────────
  const ftsCount = (db.prepare("SELECT COUNT(*) AS cnt FROM pages_fts").get() as { cnt: number })
    .cnt;
  const pagesCount = (db.prepare("SELECT COUNT(*) AS cnt FROM pages").get() as { cnt: number }).cnt;
  // FTS5 only indexes markdown — binary file types (pdf, png, csv,
  //  notebook, eml, etc.) are tracked in `pages` but skipped from
  //  `pages_fts`. Surface the breakdown so a Pages/FTS gap reads as
  //  "27 binaries" rather than as a bug. Directories are also `pages`
  //  rows (file_type='directory') but excluded from FTS.
  const markdownCount = (
    db
      .prepare("SELECT COUNT(*) AS cnt FROM pages WHERE file_type = 'markdown'")
      .get() as { cnt: number }
  ).cnt;
  const directoriesCount = (
    db
      .prepare("SELECT COUNT(*) AS cnt FROM pages WHERE file_type = 'directory'")
      .get() as { cnt: number }
  ).cnt;
  const binariesCount = pagesCount - markdownCount - directoriesCount;
  const backlinksCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM backlinks").get() as { cnt: number }
  ).cnt;
  const tagsCount = (db.prepare("SELECT COUNT(*) AS cnt FROM tags").get() as { cnt: number }).cnt;

  let chunksCount = 0;
  try {
    chunksCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM pages_chunks_fts").get() as { cnt: number }
    ).cnt;
  } catch {
    // Chunk table may not exist yet.
  }

  report.dataset = {
    ftsEntries: ftsCount,
    pages: pagesCount,
    markdownPages: markdownCount,
    directories: directoriesCount,
    binaryPages: binariesCount,
    backlinks: backlinksCount,
    tags: tagsCount,
    chunks: chunksCount,
  };

  // ─── Performance ───────────────────────────────────────────────
  if (!opts.qualityOnly) {
    const perfResults: Record<string, unknown> = {};

    // FTS5 search latency.
    const queries = ["test", "getting started", "carousel", "markdown", "agent"];
    const ftsLatencies: number[] = [];
    for (const q of queries) {
      const start = performance.now();
      db.prepare("SELECT path FROM pages_fts WHERE pages_fts MATCH ? LIMIT 10").all(`"${q}"*`);
      ftsLatencies.push(performance.now() - start);
    }
    perfResults.fts_search_p50_ms = percentile(ftsLatencies, 0.5);
    perfResults.fts_search_p95_ms = percentile(ftsLatencies, 0.95);

    // Sidebar tree load latency.
    const treeStart = performance.now();
    db.prepare("SELECT path, name, file_type AS type FROM pages ORDER BY path").all();
    perfResults.tree_load_ms = performance.now() - treeStart;

    report.performance = perfResults;
  }

  // ─── Quality ───────────────────────────────────────────────────
  if (!opts.perfOnly) {
    const quality: Record<string, unknown> = {};

    // Wiki-link integrity: what fraction of backlink targets exist as pages?
    const allTargets = db.prepare("SELECT DISTINCT target_path FROM backlinks").all() as Array<{
      target_path: string;
    }>;
    const allPaths = new Set(
      (db.prepare("SELECT path FROM pages").all() as Array<{ path: string }>).map((r) => r.path),
    );
    let brokenLinks = 0;
    for (const t of allTargets) {
      // Fuzzy match: target_path is a page title, not a file path.
      // For now, count it as broken if no page path contains the target.
      const found = [...allPaths].some((p) =>
        p.includes(t.target_path.toLowerCase().replace(/ /g, "-")),
      );
      if (!found) brokenLinks++;
    }
    quality.wikilink_integrity = allTargets.length > 0 ? 1 - brokenLinks / allTargets.length : 1;

    // Orphan pages: pages with zero inbound links.
    const linkedPaths = new Set(
      (
        db.prepare("SELECT DISTINCT source_path FROM backlinks").all() as Array<{
          source_path: string;
        }>
      ).map((r) => r.source_path),
    );
    let orphanCount = 0;
    for (const p of allPaths) {
      if (!linkedPaths.has(p) && !p.startsWith(".agents")) orphanCount++;
    }
    quality.orphan_pages = orphanCount;
    quality.orphan_rate = allPaths.size > 0 ? orphanCount / allPaths.size : 0;

    // Block-ID coverage: check a sample of markdown files for block IDs.
    let filesWithBlockIds = 0;
    let totalMdFiles = 0;
    if (existsSync(dataRoot)) {
      walkDir(dataRoot, (filePath) => {
        if (!filePath.endsWith(".md")) return;
        totalMdFiles++;
        const content = readFileSync(filePath, "utf-8");
        if (/<!-- #blk_[A-Z0-9]{26} -->/.test(content)) filesWithBlockIds++;
      });
    }
    quality.block_id_coverage = totalMdFiles > 0 ? filesWithBlockIds / totalMdFiles : 0;

    // Chunk coverage.
    quality.chunk_coverage = ftsCount > 0 ? chunksCount / ftsCount : 0;

    // Overall score (0-100).
    const scores = [
      (quality.wikilink_integrity as number) * 30,
      (1 - (quality.orphan_rate as number)) * 25,
      (quality.block_id_coverage as number) * 25,
      Math.min(1, quality.chunk_coverage as number) * 20,
    ];
    quality.overall_score = Math.round(scores.reduce((a, b) => a + b, 0));

    report.quality = quality;
  }

  db.close();

  // ─── Output ────────────────────────────────────────────────────
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\nironlore eval");
    console.log("─".repeat(60));
    console.log(`  Project: ${opts.project}`);
    console.log(`  Path:    ${projectDir}`);

    const ds = report.dataset as Record<string, number>;
    // Annotate the FTS count so the markdown-vs-binary gap is
    //  legible at a glance — e.g. "FTS entries: 20 (markdown · 27
    //  binaries skipped)" instead of "20" and a mystery delta.
    // `noUncheckedIndexedAccess` types the lookups as `number |
    // undefined`; coerce to 0 here since the report shape is built
    // upstream by `buildEvalReport` and these fields are always set.
    const binaryPages = ds.binaryPages ?? 0;
    const directories = ds.directories ?? 0;
    const skippedNote =
      binaryPages + directories > 0
        ? ` (markdown · ${binaryPages} binar${binaryPages === 1 ? "y" : "ies"} + ${directories} dir${directories === 1 ? "" : "s"} skipped)`
        : "";
    console.log(
      `  Pages:   ${ds.pages}  |  FTS entries: ${ds.ftsEntries}${skippedNote}  |  Chunks: ${ds.chunks}  |  Backlinks: ${ds.backlinks}`,
    );

    if (report.performance) {
      const p = report.performance as Record<string, number>;
      console.log("\n  Performance:");
      console.log(`    FTS search p50:  ${p.fts_search_p50_ms?.toFixed(2)}ms`);
      console.log(`    FTS search p95:  ${p.fts_search_p95_ms?.toFixed(2)}ms`);
      console.log(`    Tree load:       ${p.tree_load_ms?.toFixed(2)}ms`);
    }

    if (report.quality) {
      const q = report.quality as Record<string, number>;
      console.log("\n  Quality:");
      console.log(`    Wiki-link integrity: ${((q.wikilink_integrity ?? 0) * 100).toFixed(1)}%`);
      console.log(
        `    Orphan pages:        ${q.orphan_pages ?? 0} (${((q.orphan_rate ?? 0) * 100).toFixed(1)}%)`,
      );
      console.log(`    Block-ID coverage:   ${((q.block_id_coverage ?? 0) * 100).toFixed(1)}%`);
      console.log(`    Chunk coverage:      ${((q.chunk_coverage ?? 0) * 100).toFixed(1)}%`);
      console.log(`    OVERALL SCORE:       ${q.overall_score ?? 0}/100`);
    }

    console.log("─".repeat(60));
  }

  // Exit 1 if quality issues found.
  if (report.quality) {
    const q = report.quality as Record<string, number>;
    if ((q.overall_score ?? 0) < 50) process.exit(1);
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function walkDir(dir: string, callback: (filePath: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, callback);
    else callback(full);
  }
}
