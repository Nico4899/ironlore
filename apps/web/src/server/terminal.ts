import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import type { SessionStore } from "./auth.js";
import { buildSafeEnv } from "./spawn-safe.js";
import { authenticateUpgrade } from "./ws-auth.js";

// ---------------------------------------------------------------------------
// Terminal manager — single session per user
// ---------------------------------------------------------------------------

export class TerminalManager {
  private wss: WebSocketServer;
  private sessionStore: SessionStore;
  private verifySessionCookie: (cookie: string) => string | null;
  private dataRoot: string;
  private projectId: string;
  private activeSession: { ws: WebSocket; ptyProcess: pty.IPty } | null = null;

  constructor(
    dataRoot: string,
    sessionStore: SessionStore,
    verifySessionCookie: (cookie: string) => string | null,
    projectId: string,
  ) {
    this.dataRoot = dataRoot;
    this.sessionStore = sessionStore;
    this.verifySessionCookie = verifySessionCookie;
    this.projectId = projectId;
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Handle HTTP upgrade request for terminal WebSocket.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    authenticateUpgrade(req, socket, this.sessionStore, this.verifySessionCookie, () => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws);
      });
    });
  }

  private onConnection(ws: WebSocket): void {
    // Kill existing session if any (single-session per user)
    if (this.activeSession) {
      this.activeSession.ptyProcess.kill();
      this.activeSession.ws.close();
      this.activeSession = null;
    }

    // Spawn shell. Env is scrubbed via `buildSafeEnv` — the parent
    // process's ambient secrets (provider API keys, AWS tokens, DB URLs)
    // must NOT leak to a user-driven shell. See
    // docs/05-jobs-and-security.md §Subprocess environment scrubbing.
    const shell = process.env.SHELL ?? "/bin/sh";
    const safeEnv = buildSafeEnv({ projectId: this.projectId });
    // node-pty requires `TERM` to be set for ANSI rendering; buildSafeEnv
    // already passes through the parent's TERM, but fall back to a sane
    // default if the server is running without one.
    safeEnv.TERM = safeEnv.TERM ?? "xterm-256color";
    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: this.dataRoot,
      env: safeEnv,
    });

    this.activeSession = { ws, ptyProcess };

    // PTY → WebSocket
    ptyProcess.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    ptyProcess.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      if (this.activeSession?.ptyProcess === ptyProcess) {
        this.activeSession = null;
      }
    });

    // WebSocket → PTY
    ws.on("message", (data) => {
      try {
        // Try to parse as JSON for resize commands
        const msg = JSON.parse(data.toString()) as { type: string; cols?: number; rows?: number };
        if (msg.type === "terminal:resize" && msg.cols && msg.rows) {
          ptyProcess.resize(msg.cols, msg.rows);
          return;
        }
      } catch {
        // Not JSON — treat as terminal input
      }
      ptyProcess.write(data.toString());
    });

    ws.on("close", () => {
      ptyProcess.kill();
      if (this.activeSession?.ws === ws) {
        this.activeSession = null;
      }
    });

    ws.on("error", () => {
      ptyProcess.kill();
      if (this.activeSession?.ws === ws) {
        this.activeSession = null;
      }
    });
  }

  close(): void {
    if (this.activeSession) {
      this.activeSession.ptyProcess.kill();
      this.activeSession.ws.close();
      this.activeSession = null;
    }
    this.wss.close();
  }
}
