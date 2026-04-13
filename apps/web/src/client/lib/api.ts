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

export async function fetchPage(pagePath: string): Promise<PageResponse> {
  const res = await fetch(`${PAGES_BASE}/${pagePath}`);
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

  const res = await fetch(`${PAGES_BASE}/${pagePath}`, {
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
  const res = await fetch(PAGES_BASE);
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
  const res = await fetch(`${RAW_BASE}/${pagePath}`);
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

  const res = await fetch(`${RAW_BASE}/${pagePath}`, {
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

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API ${status}: ${body}`);
  }
}
