/** Page kind — controls agent read/write permissions. */
export type PageKind = "page" | "source" | "wiki";

/** Page type — determines which viewer to use. */
export type PageType =
  | "markdown"
  | "pdf"
  | "csv"
  | "image"
  | "video"
  | "audio"
  | "source-code"
  | "mermaid"
  | "text"
  | "transcript"
  | "word"
  | "excel"
  | "email"
  | "notebook"
  | "linked-repo"
  | "linked-dir";

/** Job status in the durable job queue. */
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Job execution mode. */
export type JobMode = "interactive" | "autonomous";

/** Agent runtime status. */
export type AgentStatus = "active" | "paused" | "exhausted";

/** Agent pause reason. */
export type PauseReason = "failure_streak" | "user" | "budget";

/** Provider identifier. */
export type ProviderId = "anthropic" | "openai" | "ollama" | "claude-cli";

/** Project preset — onboarding template for isolation and egress policy. */
export type ProjectPreset = "main" | "research" | "sandbox";

/** Frontmatter for a page. */
export interface PageFrontmatter {
  schema: number;
  id: string;
  title: string;
  kind?: PageKind;
  created: string;
  modified: string;
  tags?: string[];
  icon?: string;
  source_id?: string;
  acl?: {
    read?: string[];
    write?: string[];
  };
}

/** Health endpoint response body. */
export interface HealthResponse {
  status: "ok";
  activeJobs: number;
  walDepth: number;
  wsSubscribers: number;
  projects: number;
}

/** Ready endpoint response body. */
export interface ReadyResponse {
  ready: boolean;
  reason?: string;
}

/** Tree node for the sidebar. */
export interface TreeNode {
  id: string;
  name: string;
  path: string;
  type: PageType | "directory";
  kind?: PageKind;
  icon?: string;
  children?: TreeNode[];
}

/** Bootstrap credential record written to .ironlore-install.json. */
export interface InstallRecord {
  admin_username: string;
  initial_password: string;
  created_at: string;
}

/**
 * MCP server declaration in `project.yaml`. See
 * docs/04-ai-and-agents.md §MCP compatibility and
 * docs/05-jobs-and-security.md §MCP server lifecycle.
 */
export interface McpServerConfig {
  /** Tool prefix — surfaced to agents as `mcp.<name>.<tool>`. */
  name: string;
  /** `stdio` spawns a subprocess; `http` POSTs JSON-RPC. */
  transport: "stdio" | "http";
  /** stdio: executable path. */
  command?: string;
  /** stdio: argv. */
  args?: string[];
  /** http: endpoint URL. Subject to project egress policy. */
  url?: string;
}

/** project.yaml configuration. */
export interface ProjectConfig {
  preset: ProjectPreset;
  name: string;
  egress?: {
    policy: "open" | "allowlist" | "blocked";
    allowlist?: string[];
  };
  mcp_servers?: McpServerConfig[];
  /**
   * `single-user` (default) skips ACL parsing entirely — every
   * authenticated request can read + write every page. `multi-user`
   * enables per-page `acl:` frontmatter enforcement.
   */
  mode?: "single-user" | "multi-user";
  /**
   * Phase-11 Airlock trust boundary. `normal` (default) → the
   * project participates in cross-project `kb.global_search` fan-out.
   * `strict` → agents in *other* projects can never see this
   * project's pages, even at the cost of a downgraded run. The
   * project's own `kb.search` is unaffected.
   */
  trust?: "normal" | "strict";
  /**
   * docs/08-projects-and-isolation.md §Promotion. List of source
   * project IDs whose pages may be copied INTO this project via the
   * "Copy to project…" workflow. `undefined` (field absent) =
   * accept-from-any (backwards-compat). `[]` = accept-from-none
   * (strict, the canonical research-project default).
   */
  accept_promotions_from?: string[];
}
