import type { PageType } from "./types.js";

// ---------------------------------------------------------------------------
// Server → Client events
// ---------------------------------------------------------------------------

export interface TreeAddEvent {
  type: "tree:add";
  seq: number;
  path: string;
  name: string;
  fileType: PageType | "directory";
}

export interface TreeUpdateEvent {
  type: "tree:update";
  seq: number;
  path: string;
  etag: string;
}

export interface TreeDeleteEvent {
  type: "tree:delete";
  seq: number;
  path: string;
}

export interface TreeMoveEvent {
  type: "tree:move";
  seq: number;
  oldPath: string;
  newPath: string;
  name: string;
  fileType: PageType | "directory";
}

export interface SearchReindexedEvent {
  type: "search:reindexed";
  seq: number;
  path: string;
}

export interface ConnectedEvent {
  type: "connected";
  seq: number;
}

/**
 * Sent by the server when a reconnecting client's `?since=N` is below the
 * oldest event still in the replay buffer (or after a server restart
 * where the buffer is empty). The client must perform a full cold refresh
 * of any state it cares about (tree, inbox, search index); individual
 * event deltas are no longer recoverable.
 */
export interface ResyncEvent {
  type: "resync";
  seq: number;
  reason: "buffer_overflow" | "server_restart";
}

/**
 * Emitted once the server has finished draining the replay buffer for a
 * reconnecting client. Anything received after `replay_complete` is live.
 * Clients use this to know when it's safe to re-enable optimistic UI.
 */
export interface ReplayCompleteEvent {
  type: "replay_complete";
  seq: number;
}

/**
 * Emitted on startup when `StorageWriter.recover()` returns warnings —
 * i.e. a previous crash left WAL entries whose on-disk state matches
 * neither the pre- nor post-hash. The user must run `ironlore repair`
 * to reconcile.
 *
 * The event lives in the replay buffer, so any client connecting after
 * startup also receives it until someone actually runs repair and the
 * server emits a clearing event (future work — today the banner is
 * dismissible per session).
 *
 * See [docs/02-storage-and-sync.md §User-visible recovery surface](../../../docs/02-storage-and-sync.md).
 */
export interface RecoveryPendingEvent {
  type: "recovery:pending";
  seq: number;
  /** Relative paths (inside the project's data root) needing repair. */
  paths: string[];
  /** One-line human summary of what went wrong per path. */
  messages: string[];
}

export type WsEvent =
  | TreeAddEvent
  | TreeUpdateEvent
  | TreeDeleteEvent
  | TreeMoveEvent
  | SearchReindexedEvent
  | ConnectedEvent
  | ResyncEvent
  | ReplayCompleteEvent
  | RecoveryPendingEvent;

/** Distributive Omit — preserves union discrimination on `type`. */
export type WsEventInput = WsEvent extends infer T
  ? T extends { type: string }
    ? Omit<T, "seq">
    : never
  : never;

// ---------------------------------------------------------------------------
// Client → Server commands
// ---------------------------------------------------------------------------

export interface TerminalInputCommand {
  type: "terminal:input";
  data: string;
}

export interface TerminalResizeCommand {
  type: "terminal:resize";
  cols: number;
  rows: number;
}

export type WsCommand = TerminalInputCommand | TerminalResizeCommand;
