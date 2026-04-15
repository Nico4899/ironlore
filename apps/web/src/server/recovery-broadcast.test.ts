import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsEvent } from "@ironlore/core";
import { computeEtag } from "@ironlore/core/server";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocketType from "ws";
import type { SessionStore } from "./auth.js";
import { StorageWriter } from "./storage-writer.js";
import { WebSocketManager } from "./ws.js";

/**
 * Minimal WebSocket stand-in (same shape as `ws.test.ts`). Records
 * every `send` so we can assert exactly which frames the server emits.
 */
class MockSocket extends EventEmitter {
  public readyState = 1;
  public sent: WsEvent[] = [];
  send(payload: string | Buffer): void {
    const text = typeof payload === "string" ? payload : payload.toString("utf-8");
    this.sent.push(JSON.parse(text) as WsEvent);
  }
  ping(): void {}
  terminate(): void {
    this.emit("close");
  }
  close(): void {
    this.emit("close");
  }
}

function asMockWebSocket(s: MockSocket): WebSocketType {
  return s as unknown as WebSocketType;
}

function makeProjectDir(): string {
  const dir = join(tmpdir(), `ironlore-recovery-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore"), { recursive: true });
  return dir;
}

describe("Crash-recovery broadcast", () => {
  const writers: StorageWriter[] = [];
  const managers: WebSocketManager[] = [];

  afterEach(() => {
    for (const w of writers) w.close();
    for (const m of managers) m.close();
    writers.length = 0;
    managers.length = 0;
  });

  function makeManager(): WebSocketManager {
    const stubSessions = {
      getSession: () => ({
        id: "s",
        user_id: "u",
        current_project_id: "main",
        expires_at: "2099-01-01",
        last_seen_at: "2026-01-01",
      }),
    } as unknown as SessionStore;
    const mgr = new WebSocketManager(stubSessions, () => "session-id");
    managers.push(mgr);
    return mgr;
  }

  it("returns warnings with path+message when the WAL has an ambiguous entry", () => {
    // Simulate a crash: WAL has a write whose on-disk content matches
    // neither the pre nor the post hash (user edited the file in vim
    // during the crash window).
    const projectDir = makeProjectDir();
    const dataRoot = join(projectDir, "data");
    const target = join(dataRoot, "contested.md");
    writeFileSync(target, "content C — neither pre nor post");

    const writer = new StorageWriter(projectDir);
    writers.push(writer);
    writer.getWal().append({
      path: "contested.md",
      op: "write",
      preHash: computeEtag("content A — pre-write"),
      postHash: computeEtag("content B — post-write"),
      content: "content B — post-write",
      author: "user",
      message: "test: ambiguous recovery",
    });

    const { recovered, warningsStructured } = writer.recover();

    expect(recovered).toBe(0);
    expect(warningsStructured).toHaveLength(1);
    expect(warningsStructured[0]?.path).toBe("contested.md");
    expect(warningsStructured[0]?.message).toMatch(/neither pre nor post/i);
  });

  it("emits `recovery:pending` to a late-joining client via the replay buffer", () => {
    // Scenario: server boots, recover() produces one warning,
    // index.ts broadcasts `recovery:pending` — then a client connects.
    // The event is already in the replay buffer, so the client sees it.
    const manager = makeManager();

    // Broadcast the event as index.ts would, using structured warnings.
    manager.broadcast({
      type: "recovery:pending",
      paths: ["contested.md"],
      messages: ["hash matches neither pre nor post — run 'ironlore repair'"],
    });

    const sock = new MockSocket();
    manager.testHandshake(asMockWebSocket(sock), 0);

    // Expected frames: connected(1) → replayed recovery event(1) → replay_complete(1)
    expect(sock.sent).toHaveLength(3);
    expect(sock.sent[0]).toEqual({ type: "connected", seq: 1 });
    expect(sock.sent[1]).toMatchObject({
      type: "recovery:pending",
      seq: 1,
      paths: ["contested.md"],
    });
    expect(sock.sent[2]).toEqual({ type: "replay_complete", seq: 1 });
  });

  it("delivers `recovery:pending` live to already-connected clients", () => {
    const manager = makeManager();
    const sock = new MockSocket();
    manager.testHandshake(asMockWebSocket(sock), null);

    manager.broadcast({
      type: "recovery:pending",
      paths: ["a.md", "b.md"],
      messages: ["cannot recover", "cannot recover"],
    });

    // connected(0) + the live event(1)
    expect(sock.sent).toHaveLength(2);
    expect(sock.sent[1]).toMatchObject({
      type: "recovery:pending",
      seq: 1,
      paths: ["a.md", "b.md"],
      messages: ["cannot recover", "cannot recover"],
    });
  });
});
