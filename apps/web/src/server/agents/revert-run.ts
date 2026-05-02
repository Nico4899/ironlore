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

  // CRITICAL guard: a job with start === end produced zero commits.
  // The git log query below uses `${start}^..${end}` which when
  // start === end resolves to the *single commit at that SHA* —
  // i.e. the project's prior HEAD that the run started from. Without
  // this guard, reverting a chat-only / 0-file run silently rolls
  // back an unrelated commit (the one HEAD was at when the run
  // started), which is exactly what the audit caught: a wiki-gardener
  // analysis run with `filesChanged: []` reverted commit 668da795,
  // which was the project's *initial state* commit, not anything
  // the run touched.
  if (job.commit_sha_start === job.commit_sha_end) {
    return {
      success: false,
      revertedCommits: [],
      conflicts: [],
      error:
        "Nothing to revert: this run produced no commits (commitShaStart === commitShaEnd).",
    };
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
