import type { WsEvent } from "@ironlore/core";

type EventHandler = (event: WsEvent) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

const LAST_SEQ_KEY = "ironlore.ws.lastSeq";

/**
 * WebSocket client with automatic reconnection and replay-from-seq.
 *
 * The client remembers the last event it observed (in memory and in
 * `sessionStorage`) and passes that seq back to the server as
 * `?since=N` on reconnect. The server drains its ring buffer of any
 * events the client missed and emits `replay_complete` before live
 * streaming resumes. When the client's `since` is older than the
 * buffer window the server instead sends `resync`; the client treats
 * that as a directive to run a cold refresh of any state it cares
 * about (tree, inbox, etc.) via the `onResync` callback.
 *
 * `connected` events only arrive as the first frame after the
 * handshake and simply sync `lastSeq`; sequence-gap detection is a
 * belt-and-braces fallback for pathological cases (proxy drops a
 * frame) and also surfaces via `onResync`.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private lastSeq = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private onConnectionChange: ((connected: boolean) => void) | null = null;
  private onResync: ((reason: "buffer_overflow" | "server_restart" | "gap") => void) | null = null;
  private onReplayComplete: (() => void) | null = null;

  constructor() {
    this.lastSeq = loadLastSeq();
  }

  setConnectionChangeHandler(handler: (connected: boolean) => void): void {
    this.onConnectionChange = handler;
  }

  /**
   * Fires when the server signals that buffered replay is impossible
   * (buffer overflow, server restart) or when the client detects a
   * sequence gap anyway. Callers should trigger a cold refresh of any
   * derived state.
   */
  setResyncHandler(handler: (reason: "buffer_overflow" | "server_restart" | "gap") => void): void {
    this.onResync = handler;
  }

  /**
   * Fires after the server finishes draining replayed events on
   * reconnect. Callers can use this to re-enable optimistic UI that
   * was paused during replay.
   */
  setReplayCompleteHandler(handler: () => void): void {
    this.onReplayComplete = handler;
  }

  /** Back-compat shim — prefer setResyncHandler. */
  setGapHandler(handler: () => void): void {
    this.onResync = () => handler();
  }

  /**
   * Connect to the WebSocket server. Idempotent — a second call while
   * a socket is open or pending is a no-op.
   */
  connect(): void {
    if (this.ws) return;
    this.intentionalClose = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const suffix = this.lastSeq > 0 ? `?since=${this.lastSeq}` : "";
    const url = `${protocol}//${window.location.host}/ws${suffix}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.onConnectionChange?.(true);
    };

    this.ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as WsEvent;

        if (event.type === "connected") {
          // First frame after handshake. Align our seq to the server's
          // current value so any out-of-band gap detection below is
          // evaluated against the correct baseline.
          this.lastSeq = Math.max(this.lastSeq, event.seq);
          persistLastSeq(this.lastSeq);
          return;
        }

        if (event.type === "resync") {
          this.lastSeq = event.seq;
          persistLastSeq(this.lastSeq);
          this.onResync?.(event.reason);
          return;
        }

        if (event.type === "replay_complete") {
          this.lastSeq = event.seq;
          persistLastSeq(this.lastSeq);
          this.onReplayComplete?.();
          return;
        }

        // Belt-and-braces gap detection for pathological losses (e.g.
        // a proxy silently drops a frame). Live events should always
        // increment by exactly 1; anything else falls back to resync.
        if (event.seq > this.lastSeq + 1 && this.lastSeq > 0) {
          this.onResync?.("gap");
        }
        this.lastSeq = Math.max(this.lastSeq, event.seq);
        persistLastSeq(this.lastSeq);

        for (const handler of this.handlers) {
          handler(event);
        }
      } catch {
        // Ignore unparseable messages — never crash the event loop.
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.onConnectionChange?.(false);
      if (!this.intentionalClose) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror — reconnect handled there.
    };
  }

  /**
   * Disconnect intentionally (logout, unmount). Resets `lastSeq` to 0
   * so the next session starts fresh — a different user signing in on
   * the same machine shouldn't see stale replay state.
   */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.lastSeq = 0;
    try {
      window.sessionStorage.removeItem(LAST_SEQ_KEY);
    } catch {
      // sessionStorage denied — seq is already cleared in memory.
    }
    this.onConnectionChange?.(false);
  }

  /** Register an event handler. Returns an unsubscribe function. */
  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Current tracked seq. Exposed for test harnesses. */
  getLastSeq(): number {
    return this.lastSeq;
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

function loadLastSeq(): number {
  try {
    const raw = window.sessionStorage.getItem(LAST_SEQ_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function persistLastSeq(seq: number): void {
  try {
    window.sessionStorage.setItem(LAST_SEQ_KEY, String(seq));
  } catch {
    // sessionStorage denied (private mode, disabled storage) — replay
    // still works within the current page lifetime via in-memory state.
  }
}

/** Singleton WebSocket client instance. */
export const wsClient = new WsClient();
