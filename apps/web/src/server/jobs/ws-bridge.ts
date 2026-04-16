import type { WebSocket } from "ws";
import type Database from "better-sqlite3";

/**
 * WebSocket bridge for job events.
 *
 * Sits alongside the existing `WebSocketManager` (which handles tree
 * events). This bridge adds per-job subscriptions so the AI panel can
 * stream `job_events` rows to the client in real time.
 *
 * The client subscribes by sending `{ type: "subscribe_job", jobId }`.
 * The bridge immediately replays all events since `since` (from the
 * subscribe message or 0), then forwards live events as they're
 * emitted by the worker pool.
 *
 * On disconnect, the subscription is cleaned up. On reconnect, the
 * client re-subscribes with its `lastSeq` and gets a gap-free replay
 * from the durable `job_events` table — no in-memory buffer needed
 * because job events are already persisted (unlike tree events which
 * use the ring buffer).
 */

interface JobSubscription {
  ws: WebSocket;
  jobId: string;
  lastSeq: number;
}

export class JobEventsBridge {
  private db: Database.Database;
  private subscriptions = new Set<JobSubscription>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Subscribe a WebSocket client to a job's event stream.
   * Immediately replays events since `since`, then forwards live events.
   */
  subscribe(ws: WebSocket, jobId: string, since = 0): void {
    const sub: JobSubscription = { ws, jobId, lastSeq: since };
    this.subscriptions.add(sub);

    // Replay from the durable table.
    const events = this.db
      .prepare("SELECT seq, kind, data FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq")
      .all(jobId, since) as Array<{ seq: number; kind: string; data: string }>;

    for (const event of events) {
      if (ws.readyState !== 1) break; // OPEN
      ws.send(JSON.stringify({ type: "job_event", jobId, ...event }));
      sub.lastSeq = event.seq;
    }

    // Clean up on close.
    ws.on("close", () => {
      this.subscriptions.delete(sub);
    });
    ws.on("error", () => {
      this.subscriptions.delete(sub);
    });
  }

  /**
   * Unsubscribe a client from a specific job.
   */
  unsubscribe(ws: WebSocket, jobId: string): void {
    for (const sub of this.subscriptions) {
      if (sub.ws === ws && sub.jobId === jobId) {
        this.subscriptions.delete(sub);
        break;
      }
    }
  }

  /**
   * Called by the worker pool after appending a new event to
   * `job_events`. Forwards to any subscribed clients.
   */
  onEvent(jobId: string, seq: number, kind: string, data: unknown): void {
    const payload = JSON.stringify({ type: "job_event", jobId, seq, kind, data });
    for (const sub of this.subscriptions) {
      if (sub.jobId === jobId && sub.ws.readyState === 1) {
        sub.ws.send(payload);
        sub.lastSeq = seq;
      }
    }
  }

  /**
   * Notify subscribers that a job's status changed (done/failed/cancelled).
   */
  onJobComplete(jobId: string, status: string, result: string | null): void {
    const payload = JSON.stringify({
      type: "job_status",
      jobId,
      status,
      result,
    });
    for (const sub of this.subscriptions) {
      if (sub.jobId === jobId && sub.ws.readyState === 1) {
        sub.ws.send(payload);
      }
    }
  }

  /**
   * Get the count of active subscriptions.
   */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }
}
