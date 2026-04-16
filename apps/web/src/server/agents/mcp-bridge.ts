import type { ToolDefinition } from "../providers/types.js";
import type { ToolCallContext } from "../tools/types.js";
import { buildSafeEnv } from "../spawn-safe.js";

/**
 * MCP compatibility bridge.
 *
 * Registers external MCP servers declared in `project.yaml` and
 * merges their advertised tools into the agent's tool surface at
 * call time. MCP tool calls carry the same project scope and egress
 * policy as any native `kb.*` tool — no special privileges.
 *
 * Supported transports:
 *   - `stdio` — spawned via `spawnSafe`, communicates over stdin/stdout
 *   - `http`  — connects to a running HTTP SSE endpoint
 *
 * See docs/04-ai-and-agents.md §MCP compatibility.
 */

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  /** For stdio: the command to spawn. */
  command?: string;
  args?: string[];
  /** For http: the URL of the SSE endpoint. */
  url?: string;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * MCP server connection. Manages lifecycle + tool discovery.
 *
 * Phase 4 ships the scaffold with tool discovery + call forwarding.
 * The actual MCP protocol parsing (@modelcontextprotocol/sdk) is
 * wired when the first user reports an MCP server they want to use.
 */
export class McpBridge {
  private servers = new Map<string, McpServerConfig>();
  private discoveredTools = new Map<string, McpTool[]>();

  /**
   * Register an MCP server from project.yaml configuration.
   */
  registerServer(config: McpServerConfig): void {
    this.servers.set(config.name, config);
  }

  /**
   * Discover tools from all registered MCP servers.
   * Called once at agent-run startup.
   */
  async discoverTools(projectId: string): Promise<void> {
    for (const [name, config] of this.servers) {
      try {
        const tools = await this.listTools(config, projectId);
        this.discoveredTools.set(name, tools);
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: MCP discovery failure is diagnostic
        console.warn(`MCP server ${name}: tool discovery failed:`, err);
        this.discoveredTools.set(name, []);
      }
    }
  }

  /**
   * Get all discovered MCP tool definitions, namespaced by server.
   * Tool names are prefixed: `mcp.<server>.<tool>`.
   */
  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [serverName, tools] of this.discoveredTools) {
      for (const tool of tools) {
        defs.push({
          name: `mcp.${serverName}.${tool.name}`,
          description: `[MCP: ${serverName}] ${tool.description}`,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return defs;
  }

  /**
   * Forward a tool call to the appropriate MCP server.
   */
  async callTool(
    fullName: string,
    args: unknown,
    _ctx: ToolCallContext,
  ): Promise<string> {
    // Parse `mcp.<server>.<tool>` name.
    const parts = fullName.split(".");
    if (parts.length < 3 || parts[0] !== "mcp") {
      return JSON.stringify({ error: `Invalid MCP tool name: ${fullName}` });
    }
    const serverName = parts[1] ?? "";
    const toolName = parts.slice(2).join(".");

    const config = this.servers.get(serverName);
    if (!config) {
      return JSON.stringify({ error: `MCP server not found: ${serverName}` });
    }

    // TODO: implement actual MCP protocol call via @modelcontextprotocol/sdk.
    // For now, return a scaffold response so the tool surface is visible
    // and agents learn the naming convention.
    return JSON.stringify({
      error: "MCP tool execution not yet implemented",
      server: serverName,
      tool: toolName,
      args,
    });
  }

  /**
   * Whether any MCP servers are registered.
   */
  hasServers(): boolean {
    return this.servers.size > 0;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private async listTools(
    config: McpServerConfig,
    _projectId: string,
  ): Promise<McpTool[]> {
    if (config.transport === "stdio") {
      // Stdio: would spawn the server, send tools/list, parse response.
      // Scaffold: return empty until @modelcontextprotocol/sdk is wired.
      return [];
    }

    if (config.transport === "http" && config.url) {
      // HTTP: would GET <url>/tools, parse JSON response.
      // Scaffold: return empty.
      return [];
    }

    return [];
  }
}
