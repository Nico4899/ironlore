import type { McpServerConfig } from "@ironlore/core";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { ToolCallContext, ToolImplementation } from "../tools/types.js";
import {
  connectMcpServer,
  type McpClient,
  type McpConnectOptions,
  type McpToolDescriptor,
} from "./mcp-client.js";

/**
 * MCP compatibility bridge.
 *
 * Per-project: takes the `mcp_servers` list from `project.yaml`,
 * spins up an `McpClient` for each, discovers their advertised
 * tools, and registers each tool into the project's
 * `ToolDispatcher` as a `mcp.<server>.<tool>` `ToolImplementation`.
 *
 * The tool surface is opaque to the dispatcher — every MCP tool
 * call goes through the same `tool.call` / `tool.result` events the
 * `kb.*` tools emit, so audit, budget, and the dry-run review path
 * apply uniformly. Cross-project: a server registered here is
 * invisible to other projects' bridges (each project owns its own
 * client + connection).
 *
 * See:
 *   - docs/04-ai-and-agents.md §MCP compatibility
 *   - docs/05-jobs-and-security.md §MCP server lifecycle
 */
export class McpBridge {
  private clients = new Map<string, McpClient>();
  private discovered = new Map<string, McpToolDescriptor[]>();

  constructor(
    private readonly servers: McpServerConfig[],
    private readonly connectOpts: McpConnectOptions,
  ) {}

  hasServers(): boolean {
    return this.servers.length > 0;
  }

  /**
   * Connect to every configured server, discover its tools, and
   * register each as `mcp.<server>.<tool>` in the dispatcher. A
   * single server's failure is logged but doesn't poison the rest:
   * the bridge is a compatibility layer, not a dependency.
   */
  async discoverAndRegister(dispatcher: ToolDispatcher): Promise<void> {
    for (const config of this.servers) {
      try {
        const client = connectMcpServer(config, this.connectOpts);
        this.clients.set(config.name, client);
        const tools = await client.listTools();
        this.discovered.set(config.name, tools);
        for (const tool of tools) {
          dispatcher.register(this.makeToolImpl(config.name, tool, client));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] server '${config.name}' discovery failed: ${message}`);
        this.discovered.set(config.name, []);
      }
    }
  }

  /**
   * Number of MCP tools currently registered. Useful for telemetry
   * and the audit / settings UI ("connected to N servers, M tools").
   */
  toolCount(): number {
    let n = 0;
    for (const tools of this.discovered.values()) n += tools.length;
    return n;
  }

  /**
   * Tear down stdio child processes + abandon any in-flight HTTP
   * requests. Called from the server's shutdown path so SIGTERM
   * doesn't orphan MCP children.
   */
  async close(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const client of this.clients.values()) {
      closing.push(client.close().catch(() => undefined));
    }
    await Promise.all(closing);
    this.clients.clear();
    this.discovered.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────

  private makeToolImpl(
    serverName: string,
    tool: McpToolDescriptor,
    client: McpClient,
  ): ToolImplementation {
    return {
      definition: {
        name: `mcp.${serverName}.${tool.name}`,
        description: tool.description
          ? `[MCP: ${serverName}] ${tool.description}`
          : `[MCP: ${serverName}] ${tool.name}`,
        inputSchema: tool.inputSchema,
      },
      async execute(args: unknown, _ctx: ToolCallContext): Promise<string> {
        // Dispatcher already wraps with `tool.call` / `tool.result`
        // events — we just forward to the MCP server and return the
        // string. Errors come back stringified so the model sees a
        // structured response instead of a thrown exception.
        const { result, isError } = await client.callTool(tool.name, args);
        if (isError) {
          return JSON.stringify({ error: result, server: serverName, tool: tool.name });
        }
        return result;
      },
    };
  }
}
