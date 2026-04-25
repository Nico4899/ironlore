import { z } from "zod";
import { FRONTMATTER_SCHEMA_VERSION } from "./constants.js";

/** Zod schema for page frontmatter. */
export const PageFrontmatterSchema = z.object({
  schema: z.number().int().default(FRONTMATTER_SCHEMA_VERSION),
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["page", "source", "wiki"]).optional(),
  created: z.string().datetime(),
  modified: z.string().datetime(),
  tags: z.array(z.string()).optional(),
  icon: z.string().optional(),
  source_id: z.string().optional(),
  acl: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Per-server MCP declaration. `name` becomes the tool prefix —
 * tools surface to agents as `mcp.<name>.<tool>`. Stdio servers are
 * spawned through `spawnSafe`; http servers route through
 * `fetchForProject`, so the project's egress policy applies. See
 * docs/04-ai-and-agents.md §MCP compatibility and
 * docs/05-jobs-and-security.md §MCP server lifecycle.
 */
export const McpServerSchema = z
  .object({
    name: z.string().min(1),
    transport: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
  })
  .refine((s) => (s.transport === "stdio" ? Boolean(s.command) : true), {
    message: "stdio MCP servers require `command`",
  })
  .refine((s) => (s.transport === "http" ? Boolean(s.url) : true), {
    message: "http MCP servers require `url`",
  });

/** Zod schema for project.yaml. */
export const ProjectConfigSchema = z.object({
  preset: z.enum(["main", "research", "sandbox"]),
  name: z.string().min(1),
  egress: z
    .object({
      policy: z.enum(["open", "allowlist", "blocked"]),
      allowlist: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Declared MCP servers, per docs/04-ai-and-agents.md §MCP
   * compatibility. Empty / absent → the agent surface is just
   * `kb.*` + `agent.journal`. Cross-project: a server registered
   * here is invisible to agents in any other project.
   */
  mcp_servers: z.array(McpServerSchema).optional(),
  /**
   * Multi-user opt-in per docs/08 §Multi-user mode and per-page
   * ACLs. `single-user` (the default) skips ACL parsing entirely;
   * `multi-user` enables per-page `acl:` enforcement on every read
   * + write through the HTTP API. Switching modes requires a
   * server restart — runtime toggling would race in-flight writes.
   */
  mode: z.enum(["single-user", "multi-user"]).default("single-user"),
});

/** Zod schema for the bootstrap install record. */
export const InstallRecordSchema = z.object({
  admin_username: z.string().min(1),
  initial_password: z.string().min(24),
  created_at: z.string().datetime(),
});
