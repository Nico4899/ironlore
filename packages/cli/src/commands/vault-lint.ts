import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import Database from "better-sqlite3";

/**
 * `ironlore vault-lint` — vault-content health check.
 *
 * Mirrors the Wiki Gardener agent's five detectors, but runs as a
 * standalone CLI invocation against `.ironlore/index.sqlite` so a
 * CI pipeline (or a user without an AI provider configured) can run
 * the same audit the gardener writes to `_maintenance/lint-<DATE>.md`.
 *
 * Output: per-detector count, with `--verbose` printing the first
 * page of offenders. Exit code 0 = clean, 1 = any findings — so the
 * command slots into `pnpm vault-lint && deploy` shapes.
 *
 * The five checks (matching `kb.lint_*` tools the gardener exercises):
 *   1. Orphans — markdown pages with zero inbound wiki-links.
 *   2. Stale sources — wiki pages older than the `kind: source`
 *      pages they cite.
 *   3. Contradictions — typed `[[other | contradicts]]` links.
 *   4. Coverage gaps — wiki-link target labels cited by ≥ 3
 *      distinct pages that don't resolve to any existing page.
 *   5. Provenance gaps — `.blocks.json` blocks where `agent` is
 *      set but `derived_from` is missing.
 *
 * Implementation note: the SearchIndex's helper methods live in
 * `apps/web/src/server/`, which the CLI doesn't import (it opens
 * SQLite directly). The queries are reproduced here verbatim so a
 * schema change to either side surfaces as a divergence loud enough
 * to catch in tests.
 */

interface VaultLintOptions {
  project: string;
  verbose?: boolean;
  json?: boolean;
}

interface DetectorResult {
  name: string;
  count: number;
  sample: string[];
}

export function vaultLint(options: VaultLintOptions): void {
  const projectRoot = join(process.cwd(), "projects", options.project);
  const dbPath = join(projectRoot, ".ironlore", "index.sqlite");
  const dataRoot = join(projectRoot, "data");

  if (!existsSync(dbPath)) {
    console.error(`Project '${options.project}' has no index — run 'ironlore reindex' first.`);
    process.exit(2);
  }

  const db = new Database(dbPath, { readonly: true });
  const results: DetectorResult[] = [];

  try {
    results.push(detectOrphans(db));
    results.push(detectStaleSources(db));
    results.push(detectContradictions(db));
    results.push(detectCoverageGaps(db));
    results.push(detectProvenanceGaps(dataRoot));
  } finally {
    db.close();
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          project: options.project,
          path: projectRoot,
          timestamp: new Date().toISOString(),
          checks: Object.fromEntries(
            results.map((r) => [r.name, { count: r.count, sample: r.sample }]),
          ),
          totalFindings: results.reduce((acc, r) => acc + r.count, 0),
        },
        null,
        2,
      ),
    );
  } else {
    console.log("\nironlore vault-lint");
    console.log("─".repeat(60));
    console.log(`  Project: ${options.project}`);
    console.log(`  Path:    ${projectRoot}`);
    console.log("");
    for (const r of results) {
      const tag = r.count === 0 ? "  ✓" : "  ✗";
      console.log(`${tag} ${r.name.padEnd(22)} ${r.count}`);
      if (options.verbose && r.sample.length > 0) {
        for (const s of r.sample.slice(0, 5)) console.log(`        · ${s}`);
        if (r.sample.length > 5) console.log(`        … and ${r.sample.length - 5} more`);
      }
    }
    const total = results.reduce((acc, r) => acc + r.count, 0);
    console.log("");
    console.log("─".repeat(60));
    console.log(total === 0 ? "  Vault is clean." : `  ${total} finding(s) — see above.`);
  }

  process.exit(results.some((r) => r.count > 0) ? 1 : 0);
}

// ─── detectors ─────────────────────────────────────────────────────

const EXCLUDE_PREFIXES = ["_maintenance/", "getting-started/", ".agents/"];

/**
 * Markdown pages with zero inbound wiki-links. Mirrors
 * `SearchIndex.findOrphans`. The same path-resolution trick (try the
 * full path, the `.md`-stripped form, the basename stem) lives below.
 */
function detectOrphans(db: Database.Database): DetectorResult {
  const pages = db
    .prepare("SELECT path, updated_at FROM pages WHERE file_type = 'markdown'")
    .all() as Array<{ path: string }>;
  const targetRows = db
    .prepare("SELECT DISTINCT target_path AS target FROM backlinks")
    .all() as Array<{ target: string }>;
  const targets = new Set(targetRows.map((r) => r.target));

  const orphans: string[] = [];
  for (const page of pages) {
    if (EXCLUDE_PREFIXES.some((p) => page.path.startsWith(p))) continue;
    const candidates = linkTargetCandidates(page.path);
    const linked = candidates.some((c) => targets.has(c));
    if (!linked) orphans.push(page.path);
  }
  orphans.sort((a, b) => a.localeCompare(b));
  return { name: "Orphans", count: orphans.length, sample: orphans };
}

/**
 * Wiki pages whose cited `kind: source` is newer than the wiki itself.
 * Mirrors `SearchIndex.findStaleSources`.
 */
function detectStaleSources(db: Database.Database): DetectorResult {
  const wikis = db
    .prepare("SELECT path, updated_at FROM pages WHERE kind = 'wiki' AND file_type = 'markdown'")
    .all() as Array<{ path: string; updated_at: string }>;
  const sources = db
    .prepare("SELECT path, updated_at FROM pages WHERE kind = 'source' AND file_type = 'markdown'")
    .all() as Array<{ path: string; updated_at: string }>;
  if (wikis.length === 0 || sources.length === 0) {
    return { name: "Stale sources", count: 0, sample: [] };
  }
  const sourceByKey = new Map<string, { path: string; updated_at: string }>();
  for (const s of sources) {
    for (const key of linkTargetCandidates(s.path)) sourceByKey.set(key, s);
  }
  const getOutlinks = db.prepare(
    "SELECT DISTINCT target_path AS target FROM backlinks WHERE source_path = ?",
  );
  const stale: string[] = [];
  for (const wiki of wikis) {
    const links = getOutlinks.all(wiki.path) as Array<{ target: string }>;
    const seen = new Set<string>();
    for (const { target } of links) {
      const source = sourceByKey.get(target);
      if (!source || seen.has(source.path)) continue;
      seen.add(source.path);
      if (source.updated_at > wiki.updated_at) {
        stale.push(`${wiki.path} ← ${source.path}`);
      }
    }
  }
  return { name: "Stale sources", count: stale.length, sample: stale };
}

/**
 * Typed `[[other | contradicts]]` (or `disagrees` / `refutes`) wiki
 * links — the deterministic-relation surface from
 * `SearchIndex.findContradictions`.
 */
function detectContradictions(db: Database.Database): DetectorResult {
  const rows = db
    .prepare(
      "SELECT source_path AS s, target_path AS t, rel FROM backlinks " +
        "WHERE rel IN ('contradicts', 'disagrees', 'refutes')",
    )
    .all() as Array<{ s: string; t: string; rel: string }>;
  return {
    name: "Contradictions",
    count: rows.length,
    sample: rows.map((r) => `${r.s} ${r.rel} ${r.t}`),
  };
}

/**
 * Wiki-link targets cited by ≥ 3 distinct pages that don't resolve.
 * Mirrors `SearchIndex.findCoverageGaps` with `minMentions = 3`.
 */
function detectCoverageGaps(db: Database.Database): DetectorResult {
  const minMentions = 3;
  const targetCounts = db
    .prepare(
      "SELECT target_path AS target, COUNT(DISTINCT source_path) AS n " +
        "FROM backlinks GROUP BY target_path HAVING n >= ?",
    )
    .all(minMentions) as Array<{ target: string; n: number }>;
  const pages = db
    .prepare("SELECT path FROM pages WHERE file_type = 'markdown'")
    .all() as Array<{ path: string }>;
  const resolvedTargets = new Set<string>();
  for (const page of pages) {
    for (const cand of linkTargetCandidates(page.path)) resolvedTargets.add(cand);
  }
  const gaps = targetCounts
    .filter((r) => !resolvedTargets.has(r.target))
    .filter((r) => !EXCLUDE_PREFIXES.some((p) => r.target.startsWith(p)));
  gaps.sort((a, b) => b.n - a.n || a.target.localeCompare(b.target));
  return {
    name: "Coverage gaps",
    count: gaps.length,
    sample: gaps.map((g) => `${g.target} (×${g.n})`),
  };
}

/**
 * `.blocks.json` sidecars where `agent` is set but `derived_from` is
 * missing. Mirrors `kb.lint_provenance_gaps` — file-walk + sidecar
 * read, same exclusion list (skip dotted dirs).
 */
function detectProvenanceGaps(dataRoot: string): DetectorResult {
  if (!existsSync(dataRoot)) return { name: "Provenance gaps", count: 0, sample: [] };
  const sidecarPaths = walkSidecars(dataRoot);
  const gaps: string[] = [];
  for (const sidecarPath of sidecarPaths) {
    let parsed: { blocks?: unknown[] };
    try {
      parsed = JSON.parse(readFileSync(sidecarPath, "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.blocks)) continue;
    const mdPath = sidecarPath.replace(/\.blocks\.json$/, ".md");
    const relPath = relative(dataRoot, mdPath).split(sep).join("/");
    for (const block of parsed.blocks as Array<Record<string, unknown>>) {
      const agent = typeof block.agent === "string" ? block.agent : null;
      const derivedFrom = Array.isArray(block.derived_from) ? block.derived_from : [];
      if (agent && derivedFrom.length === 0) {
        gaps.push(`${relPath}#${block.id ?? "?"} (agent: ${agent})`);
      }
    }
  }
  return { name: "Provenance gaps", count: gaps.length, sample: gaps };
}

// ─── helpers ───────────────────────────────────────────────────────

function linkTargetCandidates(pagePath: string): string[] {
  const noExt = pagePath.replace(/\.md$/, "");
  const stem = noExt.split("/").pop() ?? noExt;
  return [pagePath, noExt, stem];
}

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
      if (entry.startsWith(".")) continue; // .ironlore, .agents, .git
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(full);
      else if (entry.endsWith(".blocks.json")) out.push(full);
    }
  }
  return out;
}
