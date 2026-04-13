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
  diff: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: PageType | "directory";
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const BASE = `/api/projects/${DEFAULT_PROJECT_ID}`;
const PAGES_BASE = `${BASE}/pages`;
const RAW_BASE = `${BASE}/raw`;

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
  const res = await apiFetch(`${PAGES_BASE}/${pagePath}`);
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

  const res = await apiFetch(`${PAGES_BASE}/${pagePath}`, {
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
  const res = await apiFetch(PAGES_BASE);
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
  return `${RAW_BASE}/${pagePath}`;
}

/** Fetch raw file content as a Response (for text-based viewers). */
export async function fetchRaw(pagePath: string): Promise<Response> {
  const res = await apiFetch(`${RAW_BASE}/${pagePath}`);
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return res;
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

  const res = await apiFetch(`${RAW_BASE}/${pagePath}`, {
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
