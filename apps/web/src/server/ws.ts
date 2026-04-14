import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WsEvent, WsEventInput } from "@ironlore/core";
import { WebSocket, WebSocketServer } from "ws";
import type { SessionStore } from "./auth.js";

// ---------------------------------------------------------------------------
// Cookie parsing (minimal — only need the session cookie value)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "ironlore_session";

function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebSocket manager
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;

interface ClientState {
  ws: WebSocket;
  alive: boolean;
}

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients = new Set<ClientState>();
  private seq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sessionStore: SessionStore;
  private verifySessionCookie: (cookie: string) => string | null;

  constructor(sessionStore: SessionStore, verifySessionCookie: (cookie: string) => string | null) {
    this.sessionStore = sessionStore;
    this.verifySessionCookie = verifySessionCookie;
    this.wss = new WebSocketServer({ noServer: true });
    this.startHeartbeat();
  }

  /**
   * Handle HTTP upgrade request. Authenticate via session cookie,
   * then upgrade to WebSocket.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Authenticate
    const cookieValue = parseCookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!cookieValue) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = this.verifySessionCookie(cookieValue);
    if (!sessionId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const session = this.sessionStore.getSession(sessionId);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws);
    });
  }

  private onConnection(ws: WebSocket): void {
    const client: ClientState = { ws, alive: true };
    this.clients.add(client);

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("close", () => {
      this.clients.delete(client);
    });

    ws.on("error", () => {
      this.clients.delete(client);
    });

    // Send initial connected event with current sequence number
    const event: WsEvent = { type: "connected", seq: this.seq };
    ws.send(JSON.stringify(event));
  }

  /**
   * Broadcast an event to all connected clients.
   * Assigns a monotonically increasing sequence number.
   */
  broadcast(event: WsEventInput): void {
    this.seq++;
    const payload = JSON.stringify({ ...event, seq: this.seq });

    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  /**
   * Get the number of connected WebSocket clients.
   */
  getSubscriberCount(): number {
    return this.clients.size;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        client.alive = false;
        client.ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Don't prevent process exit
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      client.ws.terminate();
    }
    this.clients.clear();
    this.wss.close();
  }
}
