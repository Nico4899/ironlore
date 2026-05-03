import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computeEtag } from "@ironlore/core/server";
import Database from "better-sqlite3";

/**
 * `ironlore lint --check wal-integrity` — diagnose uncommitted WAL
 * entries left over from a crash.
 *
 * Per docs/02-storage-and-sync.md §WAL crash recovery, an entry can
 * be in one of four states relative to its on-disk file:
 *
 *   - **post-write match**: file hash equals `postHash` → write
 *     completed but the commit marker was lost. Safe to mark
 *     committed.
 *   - **pre-write match**: file hash equals `preHash` → the write
 *     never landed. Safe to replay from the WAL `content`.
 *   - **neither matches**: file was partially written or modified
 *     externally during the crash window. The doc explicitly
 *     **forbids** auto-overwriting because the on-disk state may be
 *     a legitimate edit the WAL cannot know about. Surface to the
 *     user with both hashes; they pick the resolution by hand.
 *   - **delete entry**: file should be gone. If still present,
 *     replay the unlink; if already gone, mark committed.
 *
 * Without `--fix`, this command is read-only: it lists every
 * uncommitted entry with its current state. With `--fix`, cases 1,
 * 2, and 4 are repaired in place; case 3 entries remain as a
 * report (and the command exits 1) so the user can intervene.
 *
 * Exit codes: 0 if the WAL is empty or fully repaired; 1 if any
 * case-3 entries remain.
 */

interface WalRow {
  id: number;
  path: string;
  op: string;
  preHash: string | null;
  postHash: string | null;
  content: string | null;
}

type EntryState = "post-match" | "pre-match" | "neither" | "delete-pending" | "delete-done";

interface LintWalOptions {
  project: string;
  fix?: boolean;
  /**
   * Override the working directory root. Defaults to `process.cwd()`.
   * The project resolves as `<cwd>/projects/<project>`.
   */
  cwd?: string;
}

export function lintWalIntegrity(opts: LintWalOptions): void {
  const baseCwd = opts.cwd ?? process.cwd();
  const projectDir = join(baseCwd, "projects", opts.project);
  const dataRoot = join(projectDir, "data");
  // The runtime WAL lives in `.ironlore/wal/wal.sqlite` per
  // `apps/web/src/server/wal.ts:30`.
  const walPath = join(projectDir, ".ironlore", "wal", "wal.sqlite");
  if (!existsSync(walPath)) {
    console.log("    No WAL found — nothing to check.");
    return;
  }

  const db = new Database(walPath, { readonly: !opts.fix });
  let uncommitted: WalRow[];
  try {
    uncommitted = db
      .prepare(
        `SELECT id, path, op, pre_hash AS preHash, post_hash AS postHash, content
           FROM wal_entries
          WHERE committed = 0
          ORDER BY id ASC`,
      )
      .all() as WalRow[];
  } catch (err) {
    console.error(
      `    Cannot read WAL at ${walPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return; // unreachable but satisfies TS narrowing
  }

  if (uncommitted.length === 0) {
    db.close();
    console.log("    WAL clean — no uncommitted entries.");
    return;
  }

  console.log(
    `    ${uncommitted.length} uncommitted WAL entr${uncommitted.length === 1 ? "y" : "ies"}.`,
  );

  let repaired = 0;
  const ambiguous: Array<{ entry: WalRow; current: string }> = [];

  for (const entry of uncommitted) {
    const state = classify(entry, dataRoot);
    const stateLabel = describeState(state);
    console.log(
      `      [${stateLabel.padEnd(15)}] ${entry.op.padEnd(6)} ${entry.path}  (entry ${entry.id})`,
    );

    if (!opts.fix) continue;

    // --fix: repair what we safely can. Case 3 ("neither") is
    // never auto-resolved per the spec.
    switch (state.kind) {
      case "post-match":
      case "delete-done":
        markCommitted(db, entry.id);
        repaired++;
        break;
      case "pre-match":
        if (entry.content !== null) {
          replayWrite(dataRoot, entry.path, entry.content);
          markCommitted(db, entry.id);
          repaired++;
        }
        break;
      case "delete-pending":
        replayDelete(dataRoot, entry.path);
        markCommitted(db, entry.id);
        repaired++;
        break;
      case "neither":
        ambiguous.push({ entry, current: state.currentHash });
        console.log(`        ↳ on-disk hash: ${state.currentHash}`);
        console.log(`        ↳ WAL pre-hash: ${entry.preHash ?? "(none)"}`);
        console.log(`        ↳ WAL post-hash: ${entry.postHash ?? "(none)"}`);
        console.log(`        ↳ ${stateLabel}`);
        break;
    }
  }

  db.close();

  if (opts.fix && repaired > 0) {
    console.log(`    Repaired ${repaired} entr${repaired === 1 ? "y" : "ies"}.`);
  }

  if (ambiguous.length > 0) {
    console.log(
      `    ${ambiguous.length} ambiguous entr${ambiguous.length === 1 ? "y" : "ies"} — needs human review (see hashes above).`,
    );
    console.log("    Per docs/02-storage-and-sync.md §WAL crash recovery, the on-disk state may");
    console.log("    be a legitimate external edit; auto-overwriting from the WAL would clobber");
    console.log("    real work. Pick the resolution by hand — keep the on-disk file (delete the");
    console.log("    WAL row) or restore from WAL (replace the file with the entry's content).");
    process.exit(1);
  }
}

interface ClassifiedState {
  kind: EntryState;
  currentHash: string;
  toString(): string;
}

function classify(entry: WalRow, dataRoot: string): ClassifiedState {
  const absPath = join(dataRoot, entry.path);

  if (entry.op === "delete") {
    if (existsSync(absPath)) {
      return {
        kind: "delete-pending",
        currentHash: "(file present)",
        toString: () => "delete-pending",
      };
    }
    return { kind: "delete-done", currentHash: "(file absent)", toString: () => "delete-done" };
  }

  // Write op
  if (!existsSync(absPath)) {
    // File missing — treat as pre-match (write never landed) so the
    // --fix path replays it. classify() doesn't know whether the
    // pre-hash was for an existing file or a creation; the caller
    // distinguishes by entry.preHash being null.
    return { kind: "pre-match", currentHash: "(file absent)", toString: () => "pre-match" };
  }

  const current = readFileSync(absPath, "utf-8");
  const currentHash = computeEtag(current);

  if (currentHash === entry.postHash) {
    return { kind: "post-match", currentHash, toString: () => "post-match" };
  }
  if (currentHash === entry.preHash) {
    return { kind: "pre-match", currentHash, toString: () => "pre-match" };
  }
  return { kind: "neither", currentHash, toString: () => "neither" };
}

function describeState(state: ClassifiedState): string {
  switch (state.kind) {
    case "post-match":
      return "write completed but commit marker lost — safe to mark committed";
    case "pre-match":
      return "write never landed — safe to replay from WAL";
    case "neither":
      return "file modified externally during crash window — manual review required";
    case "delete-pending":
      return "delete didn't land — safe to replay";
    case "delete-done":
      return "delete already happened — safe to mark committed";
  }
}

function markCommitted(db: Database.Database, id: number): void {
  db.prepare("UPDATE wal_entries SET committed = 1 WHERE id = ?").run(id);
}

function replayWrite(dataRoot: string, relPath: string, content: string): void {
  // Reuse the same write semantics StorageWriter uses but without
  // re-entering the WAL (we're recovering from one). Smaller scale:
  // no atomic-rename — the recovery path is a one-shot.
  const absPath = join(dataRoot, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
}

function replayDelete(dataRoot: string, relPath: string): void {
  const absPath = join(dataRoot, relPath);
  try {
    unlinkSync(absPath);
  } catch {
    /* already gone */
  }
}
