import { realpathSync } from "node:fs";
import type { McpServerConfig } from "@ironlore/core";
import { fetchForProject } from "../fetch-for-project.js";
import { spawnSafe } from "../spawn-safe.js";

// `node:child_process` is banned by biome to enforce the `spawnSafe`
// pathway. We re-derive `ChildProcess` from the helper's return type
// instead of importing it directly.
type ChildProcess = ReturnType<typeof spawnSafe>;

/**
 * Minimal Model Context Protocol client.
 *
 * Hand-rolled JSON-RPC 2.0 over stdio (line-delimited JSON) and HTTP
 * (POST + JSON body). Implements only the subset Ironlore needs:
 * `initialize` (handshake), `tools/list` (discovery), `tools/call`
 * (invocation). Anything more — prompts, resources, completions —
 * is intentionally out of scope; MCP is a compatibility layer in
 * Ironlore, not a primary extension surface (docs/04-ai-and-agents.md
 * §MCP compatibility).
 *
 * Why no `@modelcontextprotocol/sdk`: every subprocess in this
 * codebase has to go through `spawnSafe` (env-scrubbed, biome rule
 * banning direct `child_process`), and every outbound HTTP through
 * `fetchForProject` (egress allowlist). Wrapping the SDK would
 * require replicating those guards anyway, so a 200-line client is
 * cleaner than 200 lines + a transitive dep.
 */

// Module-protocol version this client speaks. Servers built against
// any 2024-* date negotiate a compatible session — our requests stay
// minimal so version-skew is not a real risk for the tools/list +
// tools/call subset we use.
const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ListToolsResult {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

interface CallToolContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: unknown;
}

interface CallToolResult {
  content?: CallToolContent[];
  isError?: boolean;
}

/**
 * Common transport contract — both stdio + http back this.
 *
 * `request` issues a JSON-RPC call and resolves with the parsed
 * `result` or rejects with the JSON-RPC error. `close` releases the
 * underlying process / connection. Implementations MUST handle the
 * `initialize` handshake before any other call — handled inside
 * `connectMcpServer`, callers don't need to think about it.
 */
interface McpTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  /** Project ID — passed to `spawnSafe` for env scrubbing. */
  projectId: string;
  /** Project data root — `cwd` for stdio servers, validated via `resolveSafe`. */
  dataRoot: string;
  /** Project root — egress policy lookup for http servers. */
  projectDir: string;
  /** How long to wait for any single response (ms). */
  requestTimeoutMs?: number;
}

export class McpClient {
  private transport: McpTransport;
  /** Cached after `initialize` so repeat calls are cheap no-ops. */
  private initialized = false;

  constructor(transport: McpTransport) {
    this.transport = transport;
  }

  /**
   * MCP handshake. Idempotent — re-calling after success is a no-op.
   * Servers that don't implement `initialize` return `MethodNotFound`,
   * which we treat as "permissive": some early MCP implementations
   * jump straight to `tools/list` with no handshake.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.transport.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ironlore", version: "0.0.1" },
      });
    } catch (err) {
      // Swallow MethodNotFound (-32601) — early servers skip the
      // handshake. Anything else (transport error, malformed
      // response) genuinely should fail discovery, so re-raise.
      if (!isMethodNotFound(err)) throw err;
    }
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.initialize();
    const res = await this.transport.request<ListToolsResult>("tools/list");
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  /**
   * Invoke a tool. Returns the concatenated `text` content blocks
   * the server emitted, or a JSON.stringify of the full content
   * payload when the server returned non-text blocks (so the model
   * still sees the data, just structured).
   */
  async callTool(name: string, args: unknown): Promise<{ result: string; isError: boolean }> {
    await this.initialize();
    try {
      const res = await this.transport.request<CallToolResult>("tools/call", {
        name,
        arguments: args ?? {},
      });
      const contents = res.content ?? [];
      const textParts: string[] = [];
      let hasNonText = false;
      for (const c of contents) {
        if (c.type === "text" && typeof c.text === "string") {
          textParts.push(c.text);
        } else {
          hasNonText = true;
        }
      }
      const result =
        hasNonText && textParts.length === 0 ? JSON.stringify(contents) : textParts.join("\n");
      return { result, isError: res.isError === true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `MCP error: ${message}`, isError: true };
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

function isMethodNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === -32601,
  );
}

/**
 * Connect to a configured MCP server and return a primed client.
 * The handshake (`initialize`) is deferred until first
 * `listTools` / `callTool` so connection-time errors don't make
 * registration noisy.
 */
export function connectMcpServer(config: McpServerConfig, opts: McpConnectOptions): McpClient {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new Error(`stdio MCP server '${config.name}' missing 'command'`);
    }
    return new McpClient(makeStdioTransport(config, opts));
  }
  if (config.transport === "http") {
    if (!config.url) {
      throw new Error(`http MCP server '${config.name}' missing 'url'`);
    }
    return new McpClient(makeHttpTransport(config, opts));
  }
  throw new Error(`Unsupported MCP transport: ${(config as { transport: string }).transport}`);
}

// ─── stdio transport ─────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

function makeStdioTransport(config: McpServerConfig, opts: McpConnectOptions): McpTransport {
  const command = config.command as string;
  const args = config.args ?? [];
  const requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  // resolveSafe inside spawnSafe rejects an absolute `cwd` whose
  // text differs from `dataRoot` even when both point at the same
  // realpath (the canonical macOS `/var` → `/private/var`
  // wrinkle). Canonicalising here before handing to spawnSafe
  // dodges that without changing the security primitive.
  let canonicalRoot = opts.dataRoot;
  try {
    canonicalRoot = realpathSync(opts.dataRoot);
  } catch {
    // dataRoot doesn't exist — let spawnSafe surface the error.
  }

  let proc: ChildProcess | null = null;
  let exited = false;
  let nextRpcId = 1;
  const pending = new Map<number, PendingRequest>();
  let stdoutBuffer = "";

  function ensureSpawned(): ChildProcess {
    if (proc && !exited) return proc;
    proc = spawnSafe(command, args, {
      cwd: canonicalRoot,
      dataRoot: canonicalRoot,
      projectId: opts.projectId,
    });
    exited = false;
    proc.on("exit", (code) => {
      exited = true;
      const reason = `MCP server '${config.name}' exited with code ${code ?? "null"}`;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      pending.clear();
    });
    // Async spawn failure (ENOENT, EACCES). Without this listener
    // the error bubbles up as an unhandled exception and crashes
    // the host process — fatal for a per-project bridge that's
    // supposed to fail gracefully.
    proc.on("error", (err) => {
      exited = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    });
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      // MCP stdio transport is line-delimited JSON. Newline-split,
      // process complete frames, retain the trailing partial line.
      let newlineIdx = stdoutBuffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (line) handleResponseLine(line);
        newlineIdx = stdoutBuffer.indexOf("\n");
      }
    });
    return proc;
  }

  function handleResponseLine(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Stray non-JSON line — likely a server log or banner.
      // Servers that mix stderr-style output into stdout violate
      // the MCP spec, but we'd rather drop the line than crash the
      // client. The dispatcher's per-call timeout still fires if
      // a real response never arrives.
      return;
    }
    if (typeof parsed.id !== "number") return; // notification, ignore
    const handler = pending.get(parsed.id);
    if (!handler) return; // late response after timeout
    pending.delete(parsed.id);
    clearTimeout(handler.timer);
    if (parsed.error) {
      handler.reject(parsed.error);
    } else {
      handler.resolve(parsed.result);
    }
  }

  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      const child = ensureSpawned();
      const id = nextRpcId++;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method };
      if (params !== undefined) req.params = params;
      const payload = `${JSON.stringify(req)}\n`;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request '${method}' timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (v) => resolve(v as T),
          reject,
          timer,
        });
        if (!child.stdin?.writable) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`MCP server '${config.name}' stdin not writable`));
          return;
        }
        child.stdin.write(payload, (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(id);
            reject(err);
          }
        });
      });
    },
    async close() {
      if (proc && !exited) {
        proc.kill("SIGTERM");
      }
    },
  };
}

// ─── http transport ──────────────────────────────────────────────

function makeHttpTransport(config: McpServerConfig, opts: McpConnectOptions): McpTransport {
  const url = config.url as string;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  let nextRpcId = 1;

  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      const id = nextRpcId++;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method };
      if (params !== undefined) req.params = params;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), requestTimeoutMs);
      try {
        const res = await fetchForProject(opts.projectDir, url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(req),
          signal: ac.signal,
        });
        if (!res.ok) {
          throw new Error(
            `MCP http server '${config.name}' returned ${res.status} ${res.statusText}`,
          );
        }
        const body = (await res.json()) as JsonRpcResponse<T>;
        if (body.error) {
          throw body.error;
        }
        return body.result as T;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      // HTTP transport is per-request — no persistent state to release.
    },
  };
}
