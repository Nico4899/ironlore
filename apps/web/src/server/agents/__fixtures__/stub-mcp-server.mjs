#!/usr/bin/env node
/**
 * Tiny MCP-stdio server used by mcp-bridge.test.ts and
 * mcp-client.test.ts. Speaks the subset of JSON-RPC the Ironlore
 * MCP client uses: `initialize`, `tools/list`, `tools/call`. One
 * tool, `echo`, returns `echo: <message>` so the test can assert a
 * full round-trip.
 *
 * Kept as plain `.mjs` (not TypeScript) so tests can `spawn("node",
 * [absPath])` without depending on a transpiler being available in
 * the test environment.
 */

process.stdin.setEncoding("utf-8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf("\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
    nl = buffer.indexOf("\n");
  }
});

function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof req.id !== "number") return;

  const respond = (result) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`);
  };
  const error = (code, message) => {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code, message } })}\n`,
    );
  };

  switch (req.method) {
    case "initialize":
      respond({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-mcp", version: "0.0.1" },
      });
      return;
    case "tools/list":
      respond({
        tools: [
          {
            name: "echo",
            description: "Echoes the message argument.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
          {
            name: "fail",
            description: "Always returns an isError: true response.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;
    case "tools/call": {
      const params = req.params ?? {};
      const name = params.name;
      const args = params.arguments ?? {};
      if (name === "echo") {
        respond({
          content: [{ type: "text", text: `echo: ${args.message ?? ""}` }],
          isError: false,
        });
      } else if (name === "fail") {
        respond({
          content: [{ type: "text", text: "intentional failure" }],
          isError: true,
        });
      } else {
        error(-32602, `Unknown tool: ${name}`);
      }
      return;
    }
    default:
      error(-32601, "Method not found");
  }
}
