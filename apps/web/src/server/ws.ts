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

/**
 * Parse the optional `?since=<seq>` query parameter on the upgrade URL.
 * Used by reconnecting clients to request replay of events they missed
 * while disconnected. Returns `null` for missing / malformed values.
 */
function parseSinceParam(url: string | undefined): number | null {
  if (!url) return null;
  const idx = url.indexOf("?");
  if (idx === -1) return null;
  const qs = new URLSearchParams(url.slice(idx + 1));
  const raw = qs.get("since");
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// WebSocket manager
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Replay buffer capacity. Large enough to cover realistic disconnect
 * windows (a few minutes of brisk editing) without steady-state memory
 * pressure. Each event is ~200 bytes after JSON encoding, so the cap
 * sits around 200 KB total.
 */
const REPLAY_BUFFER_CAPACITY = 1024;

interface ClientState {
  ws: WebSocket;
  alive: boolean;
}

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients = new Set<ClientState>();
  private seq = 0;
  /**
   * Bounded ring of the most recent events. Appended to on every
   * broadcast; oldest entries drop when capacity is reached. Enables
   * replay-from-seq on reconnect.
   */
  private buffer: WsEvent[] = [];
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

    const since = parseSinceParam(req.url);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, since);
    });
  }

  private onConnection(ws: WebSocket, since: number | null): void {
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

    // Always announce the current seq first so the client can detect
    // that its handshake completed.
    const connected: WsEvent = { type: "connected", seq: this.seq };
    ws.send(JSON.stringify(connected));

    // Replay path. Only engaged when the client provided a `since`.
    if (since !== null && since < this.seq) {
      const oldest = this.buffer[0]?.seq ?? this.seq + 1;
      if (since + 1 < oldest) {
        // Requested window falls below what we still hold — tell the
        // client to run a cold refresh.
        const resync: WsEvent = {
          type: "resync",
          seq: this.seq,
          reason: this.buffer.length === 0 ? "server_restart" : "buffer_overflow",
        };
        ws.send(JSON.stringify(resync));
      } else {
        for (const ev of this.buffer) {
          if (ev.seq > since) ws.send(JSON.stringify(ev));
        }
      }
      const done: WsEvent = { type: "replay_complete", seq: this.seq };
      ws.send(JSON.stringify(done));
    }
  }

  /**
   * Broadcast an event to all connected clients.
   * Assigns a monotonically increasing sequence number.
   */
  broadcast(event: WsEventInput): void {
    this.seq++;
    const stamped = { ...event, seq: this.seq } as WsEvent;
    this.appendToBuffer(stamped);
    const payload = JSON.stringify(stamped);

    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  private appendToBuffer(event: WsEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > REPLAY_BUFFER_CAPACITY) {
      // Drop the oldest half-batch in one splice so we don't shift on
      // every single broadcast. Amortized O(1) per append.
      this.buffer.splice(0, this.buffer.length - REPLAY_BUFFER_CAPACITY);
    }
  }

  /**
   * Test-only: expose the current seq so integration tests can assert
   * replay boundaries without attaching a client.
   */
  getSeq(): number {
    return this.seq;
  }

  /**
   * Test-only: peek at the oldest buffered event's seq. Useful for
   * asserting buffer eviction under load.
   */
  getOldestBufferedSeq(): number | null {
    return this.buffer[0]?.seq ?? null;
  }

  /**
   * Test-only: run a fresh handshake against an already-open socket
   * (typically from a `ws` client in Node). Emits the same
   * `connected` / replay / `replay_complete` sequence the real
   * upgrade path does, so integration tests can verify replay
   * without exercising the HTTP upgrade dance.
   */
  testHandshake(ws: WebSocket, since: number | null): void {
    this.onConnection(ws, since);
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
