import type { PageType } from "@ironlore/core";
import { DEFAULT_PROJECT_ID } from "@ironlore/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageResponse {
  content: string;
  etag: string;
  blocks: Array<{ id: string; type: string; text: string }>;
}

export interface SaveResponse {
  etag: string;
}

export interface ConflictResponse {
  error: "Conflict";
  currentEtag: string;
  /** Unified-diff patch of attempted save → server current; display-only. */
  diff: string;
  /** Full server-current markdown — used by the block-level merge UI. */
  currentContent: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: PageType | "directory";
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

/**
 * The active project ID. Initially `main`; updated by `setApiProject()`
 * as soon as the auth store learns the real value from `/api/auth/me`
 * (see ../stores/auth.ts). All BASE helpers below read this at call
 * time so a mid-session project switch is picked up without reloading
 * the module.
 *
 * Per docs/08-projects-and-isolation.md §Project switcher UX, the
 * switcher itself triggers a full `window.location.reload()` on
 * switch, but every API call still re-reads the value defensively so
 * the header chip and any mid-flight request after login agree.
 */
let currentProjectId: string = DEFAULT_PROJECT_ID;

export function setApiProject(projectId: string): void {
  currentProjectId = projectId;
}

export function getApiProject(): string {
  return currentProjectId;
}

const base = (): string => `/api/projects/${currentProjectId}`;
const pagesBase = (): string => `${base()}/pages`;
const rawBase = (): string => `${base()}/raw`;

/**
 * Fetch wrapper that intercepts 401 responses and clears the auth session.
 * All data API functions use this instead of raw fetch.
 */
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    const { useAuthStore } = await import("../stores/auth.js");
    useAuthStore.getState().clearSession();
    throw new ApiError(401, "Session expired");
  }
  return res;
}

export async function fetchPage(pagePath: string): Promise<PageResponse> {
  const res = await apiFetch(`${pagesBase()}/${pagePath}`);
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return res.json() as Promise<PageResponse>;
}

export async function savePage(
  pagePath: string,
  markdown: string,
  etag: string | null,
): Promise<SaveResponse | ConflictResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (etag) {
    headers["If-Match"] = etag;
  }

  const res = await apiFetch(`${pagesBase()}/${pagePath}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ markdown }),
  });

  if (res.status === 409) {
    return res.json() as Promise<ConflictResponse>;
  }

  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }

  return res.json() as Promise<SaveResponse>;
}

export async function fetchTree(): Promise<{ pages: TreeEntry[] }> {
  const res = await apiFetch(pagesBase());
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return res.json() as Promise<{ pages: TreeEntry[] }>;
}

// ---------------------------------------------------------------------------
// Raw file API (for non-markdown viewers)
// ---------------------------------------------------------------------------

/** Build the URL for raw file access (for <img>, <video>, <audio> src). */
export function fetchRawUrl(pagePath: string): string {
  return `${rawBase()}/${pagePath}`;
}

/** Fetch raw file content as a Response (for text-based viewers). */
export async function fetchRaw(pagePath: string): Promise<Response> {
  const res = await apiFetch(`${rawBase()}/${pagePath}`);
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return res;
}

/**
 * Create a new text-based file through the raw API. Used for non-markdown
 * file creation from the sidebar (e.g. `.py`, `.csv`, `.mermaid`).
 */
export async function createRawFile(pagePath: string, content: string): Promise<void> {
  const res = await apiFetch(`${rawBase()}/${pagePath}`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: content,
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
}

/** Save CSV content via the raw API. */
export async function saveCsv(
  pagePath: string,
  content: string,
  etag: string | null,
): Promise<SaveResponse | ConflictResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "text/csv",
  };
  if (etag) {
    headers["If-Match"] = etag;
  }

  const res = await apiFetch(`${rawBase()}/${pagePath}`, {
    method: "PUT",
    headers,
    body: content,
  });

  if (res.status === 409) {
    return res.json() as Promise<ConflictResponse>;
  }

  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }

  return res.json() as Promise<SaveResponse>;
}

// ---------------------------------------------------------------------------
// Search API
// ---------------------------------------------------------------------------

const searchBase = (): string => `${base()}/search`;

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface BacklinkEntry {
  sourcePath: string;
  linkText: string;
}

export interface RecentEdit {
  path: string;
  updatedAt: string;
  author: string;
}

/** Full-text search via FTS5. */
export async function searchPages(query: string, limit = 20): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await apiFetch(`${searchBase()}/search?${params}`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const data = (await res.json()) as { results: SearchResult[] };
  return data.results;
}

/** Get pages that link to the given path. */
export async function fetchBacklinks(path: string): Promise<BacklinkEntry[]> {
  const params = new URLSearchParams({ path });
  const res = await apiFetch(`${searchBase()}/backlinks?${params}`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const data = (await res.json()) as { backlinks: BacklinkEntry[] };
  return data.backlinks;
}

/** Get recently edited pages. */
export async function fetchRecentEdits(limit = 20): Promise<RecentEdit[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await apiFetch(`${searchBase()}/recent?${params}`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const data = (await res.json()) as { pages: RecentEdit[] };
  return data.pages;
}

/** Create a new page (PUT with no If-Match). */
export async function createPage(pagePath: string, content: string): Promise<SaveResponse> {
  const res = await apiFetch(`${pagesBase()}/${pagePath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: content }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<SaveResponse>;
}

/** Move a page to a new path. */
export async function movePage(sourcePath: string, destination: string): Promise<SaveResponse> {
  const res = await apiFetch(`${pagesBase()}/${sourcePath}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destination }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<SaveResponse>;
}

/**
 * Delete a page. Pass an ETag via `etag` for editor-session deletes
 * (server enforces If-Match); omit it for sidebar deletes of files
 * the user hasn't opened.
 */
export async function deletePage(pagePath: string, etag?: string | null): Promise<void> {
  const headers: Record<string, string> = {};
  if (etag) headers["If-Match"] = etag;
  const res = await apiFetch(`${pagesBase()}/${pagePath}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok && res.status !== 204) {
    throw new ApiError(res.status, await res.text());
  }
}

/** Create an empty folder. */
export async function createFolder(dirPath: string): Promise<void> {
  const res = await apiFetch(`${pagesBase()}/folders/${dirPath}`, {
    method: "POST",
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
}

/** Recursively delete a folder and its contents. */
export async function deleteFolder(dirPath: string): Promise<void> {
  const res = await apiFetch(`${pagesBase()}/folders/${dirPath}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    throw new ApiError(res.status, await res.text());
  }
}

/** Upload a binary file (docx, xlsx, pdf, image, etc.). */
export async function uploadFile(
  filePath: string,
  data: ArrayBuffer,
): Promise<{ path: string; etag: string }> {
  const res = await apiFetch(`${rawBase()}/upload/${filePath}`, {
    method: "POST",
    body: data,
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

// ---------------------------------------------------------------------------
// Jobs / Agent API
// ---------------------------------------------------------------------------

const jobsBase = (): string => `${base()}/jobs`;

/** Fetch pending inbox entries. */
export async function fetchInbox(): Promise<{
  entries: Array<{
    id: string;
    agentSlug: string;
    branch: string;
    jobId: string;
    filesChanged: string[];
    finalizedAt: number;
    status: string;
  }>;
}> {
  const res = await apiFetch(`${base()}/inbox`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/** Read an agent's rails state — whether it can enqueue a run + reason. */
export async function fetchAgentState(
  slug: string,
): Promise<{ slug: string; canRun: boolean; reason: string | null }> {
  const res = await apiFetch(`${base()}/agents/${slug}/state`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/** Pause / resume an agent via the rails state PATCH. */
export async function setAgentPaused(
  slug: string,
  paused: boolean,
): Promise<{ ok: boolean; paused: boolean }> {
  const res = await apiFetch(`${base()}/agents/${slug}/state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/** One row from the agent detail page's recent-runs table. */
export interface AgentRunRecord {
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "healthy" | "warn" | "error";
  stepCount: number;
  note: string | null;
  commitShaStart: string | null;
  commitShaEnd: string | null;
}

/** Rolling-24h activity histogram payload. */
export interface AgentHistogramResponse {
  windowStart: number;
  windowEnd: number;
  bucketHours: number;
  buckets: number[];
  cap: { perHour: number; perDay: number };
}

/** Read-only projection of the agent's rails state + persona paths. */
export interface AgentConfigResponse {
  slug: string;
  status: "active" | "paused";
  pauseReason: string | null;
  maxRunsPerHour: number;
  maxRunsPerDay: number;
  failureStreak: number;
  personaPath: string | null;
  personaMtimeDriftSeconds: number | null;
  /** Persona-frontmatter projection — null when file missing / malformed. */
  persona: {
    heartbeat: string | null;
    reviewMode: "auto-commit" | "inbox" | null;
    tools: string[] | null;
    budget: { tokens: number | null; toolCalls: number | null; fsyncMs: number | null } | null;
    scope: { pages: string[] | null; writableKinds: string[] | null } | null;
  } | null;
}

/** Fetch the last N runs for an agent — newest first. */
export async function fetchAgentRuns(slug: string, limit = 24): Promise<AgentRunRecord[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await apiFetch(`${base()}/agents/${slug}/runs?${params}`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const data = (await res.json()) as { runs: AgentRunRecord[] };
  return data.runs;
}

/** Fetch the 24h activity histogram for an agent. */
export async function fetchAgentHistogram(slug: string): Promise<AgentHistogramResponse> {
  const res = await apiFetch(`${base()}/agents/${slug}/histogram`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/** Fetch the agent's rails config projection. */
export async function fetchAgentConfig(slug: string): Promise<AgentConfigResponse> {
  const res = await apiFetch(`${base()}/agents/${slug}/config`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export interface AgentListEntry {
  slug: string;
  status: "active" | "paused";
}

/** List every agent installed in the current project (slug + status only). */
export async function fetchAgents(): Promise<AgentListEntry[]> {
  const res = await apiFetch(`${base()}/agents`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const data = (await res.json()) as { agents: AgentListEntry[] };
  return data.agents;
}

/** Per-file diff row for an inbox entry. */
export interface InboxFileDiff {
  path: string;
  status: "A" | "D" | "M" | "R" | "?";
  /** null when git reports `-` (binary file). */
  added: number | null;
  /** null when git reports `-` (binary file). */
  removed: number | null;
  /** User decision captured during review; null = undecided. */
  decision: "approved" | "rejected" | null;
}

/**
 * Set (or clear) the user's per-file decision for an inbox entry.
 * Passing `null` clears the row, restoring default-accept at the
 * next `approveInboxEntry`.
 */
export async function setInboxFileDecision(
  entryId: string,
  path: string,
  decision: "approved" | "rejected" | null,
): Promise<{ success: boolean; error?: string }> {
  const res = await apiFetch(`${base()}/inbox/${entryId}/files/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, decision }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/**
 * Compute per-file diff stats for an inbox entry's staging branch
 * vs. main. Used by the Inbox UI to render the `A/D/M path +N -M` row
 * grammar per docs/09-ui-and-brand.md §Agent Inbox.
 */
export async function fetchInboxFiles(entryId: string): Promise<InboxFileDiff[]> {
  const res = await apiFetch(`${base()}/inbox/${entryId}/files`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const data = (await res.json()) as { files: InboxFileDiff[] };
  return data.files;
}

/** Approve an inbox entry (merge staging branch to main). */
export async function approveInboxEntry(
  entryId: string,
): Promise<{ success: boolean; error?: string }> {
  const res = await apiFetch(`${base()}/inbox/${entryId}/approve`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/** Reject an inbox entry (delete staging branch). */
export async function rejectInboxEntry(
  entryId: string,
): Promise<{ success: boolean; error?: string }> {
  const res = await apiFetch(`${base()}/inbox/${entryId}/reject`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/** Submit onboarding wizard answers — applies template substitution to library personas. */
export async function submitOnboarding(answers: {
  company_name: string;
  company_description: string;
  goals: string;
}): Promise<{ ok: boolean; updated: number }> {
  const res = await apiFetch(`${base()}/agents/onboarding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(answers),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/** Revert a completed agent run via git revert. */
export async function revertJob(
  jobId: string,
): Promise<{ success: boolean; revertedCommits: string[]; conflicts: string[]; error?: string }> {
  const res = await apiFetch(`${jobsBase()}/${jobId}/revert`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/**
 * Submit a dry-run verdict for a pending destructive tool call. The
 * server resolves the DryRunBridge handshake and the dispatcher either
 * proceeds with the mutation (`approve`) or returns a skipped result
 * (`reject`).
 */
export async function submitDryRunVerdict(
  jobId: string,
  toolCallId: string,
  verdict: "approve" | "reject",
): Promise<{ ok: boolean }> {
  const res = await apiFetch(`${jobsBase()}/${jobId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolCallId, verdict }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

export interface AuthSession {
  authenticated: boolean;
  username: string;
  currentProjectId: string;
  mustChangePassword: boolean;
}

interface LoginResponse {
  username: string;
  mustChangePassword: boolean;
}

/** Probe session state. Returns null if not authenticated. */
export async function fetchMe(): Promise<AuthSession | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<AuthSession>;
}

/** A project row as the switcher sees it (no credentials, no internals). */
export interface ProjectListEntry {
  id: string;
  name: string;
  preset: "main" | "research" | "sandbox";
  createdAt: string;
}

/** List every installed project. Powers the Cmd+P switcher. */
export async function fetchProjects(): Promise<ProjectListEntry[]> {
  const res = await apiFetch("/api/projects");
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const data = (await res.json()) as { projects: ProjectListEntry[] };
  return data.projects;
}

/** Log in with username and password. Throws on bad creds (401) or rate limit (429). */
export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<LoginResponse>;
}

/** Log out and clear the session cookie. */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

/** Change password. Throws on wrong current password (401) or validation error (400). */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API ${status}: ${body}`);
  }
}
