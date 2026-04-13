import type { WsEvent } from "@ironlore/core";

type EventHandler = (event: WsEvent) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * WebSocket client with automatic reconnection and sequence tracking.
 *
 * Connects to the server's `/ws` endpoint and dispatches parsed events
 * to registered handlers. Reconnects with exponential backoff on close.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private lastSeq = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private onConnectionChange: ((connected: boolean) => void) | null = null;
  private onGapDetected: (() => void) | null = null;

  /**
   * Set a callback for connection state changes.
   */
  setConnectionChangeHandler(handler: (connected: boolean) => void): void {
    this.onConnectionChange = handler;
  }

  /**
   * Set a callback for when a sequence gap is detected (missed events).
   * The caller should trigger a full tree refresh.
   */
  setGapHandler(handler: () => void): void {
    this.onGapDetected = handler;
  }

  /**
   * Connect to the WebSocket server.
   */
  connect(): void {
    if (this.ws) return;
    this.intentionalClose = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.onConnectionChange?.(true);
    };

    this.ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as WsEvent;

        // Check for sequence gaps (missed events during disconnect)
        if (event.type === "connected") {
          if (this.lastSeq > 0 && event.seq > this.lastSeq) {
            // Server moved forward while we were disconnected
            this.onGapDetected?.();
          }
          this.lastSeq = event.seq;
          return;
        }

        // Detect gaps in normal events
        if (event.seq > this.lastSeq + 1 && this.lastSeq > 0) {
          this.onGapDetected?.();
        }
        this.lastSeq = event.seq;

        for (const handler of this.handlers) {
          handler(event);
        }
      } catch {
        // Ignore unparseable messages
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.onConnectionChange?.(false);

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror — reconnect handled there
    };
  }

  /**
   * Disconnect intentionally (logout, unmount).
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
    this.onConnectionChange?.(false);
  }

  /**
   * Register an event handler. Returns an unsubscribe function.
   */
  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/** Singleton WebSocket client instance. */
export const wsClient = new WsClient();
