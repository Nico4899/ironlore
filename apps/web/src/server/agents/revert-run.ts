import { execSync } from "node:child_process";
import { join } from "node:path";
import type { JobRow } from "../jobs/types.js";

/**
 * Revert an agent run via `git revert`.
 *
 * Scoped to the job's `commit_sha_start..commit_sha_end` range and
 * the files the run actually touched. Non-destructive (adds inverting
 * commits, never rewrites history). Conflicts with subsequent edits
 * surface the standard block-level merge UI.
 *
 * See docs/04-ai-and-agents.md §Structured conversation UI and
 * docs/02-storage-and-sync.md §Git as history.
 */

export interface RevertResult {
  success: boolean;
  revertedCommits: string[];
  conflicts: string[];
  error?: string;
}

/**
 * Revert all commits produced by an agent run.
 *
 * @param job The completed job with `commit_sha_start` and `commit_sha_end` set.
 * @param projectDir The project root (contains `.git/`).
 */
export function revertAgentRun(job: JobRow, projectDir: string): RevertResult {
  if (!job.commit_sha_start || !job.commit_sha_end) {
    return {
      success: false,
      revertedCommits: [],
      conflicts: [],
      error: "Job has no commit range — nothing to revert.",
    };
  }

  // CRITICAL guard: refuse jobs that wrote nothing.
  //
  // The executor records `commit_sha_start = HEAD before run` and
  // `commit_sha_end = HEAD after run`. When the run made 0 commits
  // both SHAs are the project's prior HEAD — and the git log query
  // below (`${start}^..${end}`) happily returns that prior commit,
  // so without this guard we'd revert an unrelated commit the run
  // never touched. The audit caught exactly this: a chat-only
  // wiki-gardener analysis run with `filesChanged: []` reported
  // `success: true` and "reverted" commit 668da795 — which was
  // the project's *initial state* commit.
  //
  // SHA equality alone isn't a reliable no-op signal (a 1-commit
  // run could in principle have start === end too in some test
  // shapes), so we trust the executor's authoritative
  // `filesChanged` array stamped in the job result blob. Empty
  // array → nothing to revert.
  if (job.result) {
    try {
      const parsed = JSON.parse(job.result) as { filesChanged?: unknown };
      if (Array.isArray(parsed.filesChanged) && parsed.filesChanged.length === 0) {
        return {
          success: false,
          revertedCommits: [],
          conflicts: [],
          error: "Nothing to revert: this run produced no file changes.",
        };
      }
    } catch {
      // Result blob isn't valid JSON — fall through to the git
      // path (existing semantics for legacy / unstructured rows).
    }
  }

  const gitDir = join(projectDir, ".git");
  const revertedCommits: string[] = [];
  const conflicts: string[] = [];

  try {
    // List commits in the range (oldest first).
    const logOutput = execSync(
      `git --git-dir="${gitDir}" --work-tree="${projectDir}" log --reverse --format="%H" ${job.commit_sha_start}^..${job.commit_sha_end}`,
      { encoding: "utf-8" },
    ).trim();

    if (!logOutput) {
      return {
        success: false,
        revertedCommits: [],
        conflicts: [],
        error: "No commits found in the specified range.",
      };
    }

    const commitShas = logOutput.split("\n").filter(Boolean);

    // Revert in reverse order (newest first) to minimize conflicts.
    for (const sha of commitShas.reverse()) {
      try {
        execSync(`git --git-dir="${gitDir}" --work-tree="${projectDir}" revert --no-edit ${sha}`, {
          encoding: "utf-8",
          stdio: "pipe",
        });
        revertedCommits.push(sha);
      } catch (_err) {
        // Revert conflict — record and continue.
        conflicts.push(sha);
        // Abort the conflicting revert so git is clean for the next one.
        try {
          execSync(`git --git-dir="${gitDir}" --work-tree="${projectDir}" revert --abort`, {
            encoding: "utf-8",
            stdio: "pipe",
          });
        } catch {
          // Already clean.
        }
      }
    }

    return {
      success: conflicts.length === 0,
      revertedCommits,
      conflicts,
    };
  } catch (err) {
    return {
      success: false,
      revertedCommits,
      conflicts,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
