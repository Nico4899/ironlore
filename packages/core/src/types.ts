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
  | "app-fullscreen"
  | "app-embedded"
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
export type ProviderId = "anthropic" | "openai" | "ollama" | "claude-cli" | "acp";

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

/** project.yaml configuration. */
export interface ProjectConfig {
  preset: ProjectPreset;
  name: string;
  egress?: {
    policy: "open" | "allowlist" | "blocked";
    allowlist?: string[];
  };
}
