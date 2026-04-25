import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolDispatcher } from "../tools/dispatcher.js";
import type { RunBudget, ToolCallContext } from "../tools/types.js";
import { McpBridge } from "./mcp-bridge.js";

/**
 * MCP bridge integration — `project.yaml`-declared stdio server is
 * spawned through `spawnSafe`, its tools are discovered and merged
 * into the project's `ToolDispatcher` as `mcp.<server>.<tool>`, and
 * a real dispatch round-trip lands the server's response in the
 * `tool.result` event the agent sees.
 *
 * Fixture: `__fixtures__/stub-mcp-server.mjs` — a 70-line Node
 * script that speaks JSON-RPC for `initialize` / `tools/list` /
 * `tools/call`. Two tools: `echo` (success path) and `fail`
 * (error-shaped response).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STUB_PATH = resolve(__dirname, "__fixtures__/stub-mcp-server.mjs");

interface Fx {
  projectDir: string;
  dataRoot: string;
}

function makeFx(): Fx {
  const projectDir = join(tmpdir(), `mcp-bridge-test-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(projectDir, "data");
  mkdirSync(dataRoot, { recursive: true });
  // Minimal project.yaml so loadProjectConfig doesn't choke.
  // The test constructs McpBridge directly instead of going through
  // index.ts's startup loop, so the YAML isn't strictly required —
  // but writing one keeps the fixture realistic.
  writeFileSync(join(projectDir, "project.yaml"), "preset: main\nname: Main\n", "utf-8");
  return { projectDir, dataRoot };
}

function teardown(fx: Fx): void {
  try {
    rmSync(fx.projectDir, { recursive: true, force: true });
  } catch {
    /* */
  }
}

function makeCtx(fx: Fx): ToolCallContext {
  return {
    projectId: "main",
    agentSlug: "test",
    jobId: "j1",
    emitEvent: () => undefined,
    dataRoot: fx.dataRoot,
    fetch: globalThis.fetch,
  };
}

function makeBudget(): RunBudget {
  return { maxTokens: 100_000, maxToolCalls: 50, usedTokens: 0, usedToolCalls: 0 };
}

describe("McpBridge — stdio discovery + dispatch", () => {
  let fx: Fx;

  beforeEach(() => {
    fx = makeFx();
  });

  afterEach(() => {
    teardown(fx);
  });

  it("discovers tools from a running stdio server and registers them in the dispatcher", async () => {
    const bridge = new McpBridge(
      [{ name: "stub", transport: "stdio", command: "node", args: [STUB_PATH] }],
      { projectId: "main", dataRoot: fx.dataRoot, projectDir: fx.projectDir },
    );
    const dispatcher = new ToolDispatcher();
    await bridge.discoverAndRegister(dispatcher);

    const names = dispatcher.getDefinitions().map((d) => d.name);
    expect(names).toContain("mcp.stub.echo");
    expect(names).toContain("mcp.stub.fail");
    expect(bridge.toolCount()).toBe(2);

    await bridge.close();
  });

  it("namespaces and surfaces the server's description with an [MCP: name] prefix", async () => {
    const bridge = new McpBridge(
      [{ name: "stub", transport: "stdio", command: "node", args: [STUB_PATH] }],
      { projectId: "main", dataRoot: fx.dataRoot, projectDir: fx.projectDir },
    );
    const dispatcher = new ToolDispatcher();
    await bridge.discoverAndRegister(dispatcher);

    const echoDef = dispatcher.getDefinitions().find((d) => d.name === "mcp.stub.echo");
    expect(echoDef).toBeDefined();
    expect(echoDef?.description).toContain("[MCP: stub]");
    expect(echoDef?.description).toContain("Echoes");

    await bridge.close();
  });

  it("dispatches a tool call through the JSON-RPC client and returns the server's response", async () => {
    const bridge = new McpBridge(
      [{ name: "stub", transport: "stdio", command: "node", args: [STUB_PATH] }],
      { projectId: "main", dataRoot: fx.dataRoot, projectDir: fx.projectDir },
    );
    const dispatcher = new ToolDispatcher();
    await bridge.discoverAndRegister(dispatcher);

    const events: Array<{ kind: string; data: unknown }> = [];
    const ctx: ToolCallContext = {
      ...makeCtx(fx),
      emitEvent: (kind, data) => events.push({ kind, data }),
    };
    const out = await dispatcher.call(
      "mcp.stub.echo",
      { message: "hello world" },
      ctx,
      makeBudget(),
    );
    expect(out.isError).toBe(false);
    expect(out.result).toBe("echo: hello world");

    // The dispatcher emitted the same `tool.call` / `tool.result`
    // events it does for kb.* tools — MCP integrates as a peer.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("tool.call");
    expect(kinds).toContain("tool.result");

    await bridge.close();
  });

  it("surfaces a server-side isError response as a structured tool error", async () => {
    const bridge = new McpBridge(
      [{ name: "stub", transport: "stdio", command: "node", args: [STUB_PATH] }],
      { projectId: "main", dataRoot: fx.dataRoot, projectDir: fx.projectDir },
    );
    const dispatcher = new ToolDispatcher();
    await bridge.discoverAndRegister(dispatcher);

    const out = await dispatcher.call("mcp.stub.fail", {}, makeCtx(fx), makeBudget());
    // The server set `isError: true`; bridge wraps the message in
    // `{ error, server, tool }` so the model sees structured data.
    expect(out.isError).toBe(false); // dispatcher succeeded, server-error is a string result
    const parsed = JSON.parse(out.result) as { error?: string; server?: string; tool?: string };
    expect(parsed.server).toBe("stub");
    expect(parsed.tool).toBe("fail");
    expect(parsed.error).toContain("intentional failure");

    await bridge.close();
  });

  it("a server that fails to connect is logged but doesn't poison the dispatcher", async () => {
    // Two servers: one good, one bad (non-existent command).
    const bridge = new McpBridge(
      [
        { name: "broken", transport: "stdio", command: "/nonexistent/binary", args: [] },
        { name: "stub", transport: "stdio", command: "node", args: [STUB_PATH] },
      ],
      { projectId: "main", dataRoot: fx.dataRoot, projectDir: fx.projectDir },
    );
    const dispatcher = new ToolDispatcher();
    await bridge.discoverAndRegister(dispatcher);

    const names = dispatcher.getDefinitions().map((d) => d.name);
    expect(names).toContain("mcp.stub.echo");
    expect(names.some((n) => n.startsWith("mcp.broken."))).toBe(false);

    await bridge.close();
  });

  it("hasServers / toolCount track configured + discovered state", async () => {
    const empty = new McpBridge([], {
      projectId: "main",
      dataRoot: fx.dataRoot,
      projectDir: fx.projectDir,
    });
    expect(empty.hasServers()).toBe(false);
    expect(empty.toolCount()).toBe(0);

    const populated = new McpBridge(
      [{ name: "stub", transport: "stdio", command: "node", args: [STUB_PATH] }],
      { projectId: "main", dataRoot: fx.dataRoot, projectDir: fx.projectDir },
    );
    expect(populated.hasServers()).toBe(true);
    // Pre-discovery, toolCount is 0.
    expect(populated.toolCount()).toBe(0);
    const dispatcher = new ToolDispatcher();
    await populated.discoverAndRegister(dispatcher);
    expect(populated.toolCount()).toBe(2);

    await populated.close();
  });
});
