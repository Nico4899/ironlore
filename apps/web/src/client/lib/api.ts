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
  type: "file" | "directory";
  kind?: string;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const BASE = `/api/projects/${DEFAULT_PROJECT_ID}/pages`;

export async function fetchPage(pagePath: string): Promise<PageResponse> {
  const res = await fetch(`${BASE}/${pagePath}`);
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

  const res = await fetch(`${BASE}/${pagePath}`, {
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
  const res = await fetch(BASE);
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return res.json() as Promise<{ pages: TreeEntry[] }>;
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
