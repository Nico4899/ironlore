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

export type WsEvent =
  | TreeAddEvent
  | TreeUpdateEvent
  | TreeDeleteEvent
  | TreeMoveEvent
  | SearchReindexedEvent
  | ConnectedEvent;

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
