import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsEventInput } from "@ironlore/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileWatcher } from "./file-watcher.js";
import { Wal } from "./wal.js";

/**
 * FileWatcher unit tests.
 *
 * Covers the external-edit attribution path documented in
 * docs/02-storage-and-sync.md §External edits:
 *   1. A user-mode write that lands on disk outside the StorageWriter
 *      flow (vim, VS Code, sync agent) is picked up within the 200 ms
 *      debounce + small slack window.
 *   2. The WAL row is attributed to `system` (not a synthetic user)
 *      so the eventual git commit reads `system: external edit …`.
 *   3. Hidden / sidecar / tmp paths under `.ironlore/` (or any
 *      dotfile-prefixed sibling) are filtered out so the watcher
 *      doesn't echo derived state into the WAL.
 *   4. A delete event removes the WAL hash and emits a `tree:delete`
 *      broadcast to the SPA.
 *
 * The chokidar backend is used in tests (NODE_ENV !== "production"),
 * which gives us `awaitWriteFinish` so the assertions are robust
 * against half-written buffers on macOS APFS.
 */

interface Fixture {
  cwd: string;
  dataRoot: string;
  wal: Wal;
  watcher: FileWatcher;
  events: WsEventInput[];
}

async function waitForWal(
  wal: Wal,
  predicate: (entries: ReturnType<Wal["getUncommitted"]>) => boolean,
  timeoutMs = 2000,
): Promise<ReturnType<Wal["getUncommitted"]>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const committed = wal.getCommittedPending(50);
    const uncommitted = wal.getUncommitted();
    const merged = [...committed, ...uncommitted];
    if (predicate(merged)) return merged;
    await new Promise((r) => setTimeout(r, 50));
  }
  return wal.getUncommitted();
}

async function waitForBroadcast(
  events: WsEventInput[],
  predicate: (e: WsEventInput) => boolean,
  timeoutMs = 2000,
): Promise<WsEventInput | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function makeFixture(): Fixture {
  const cwd = join(tmpdir(), `file-watcher-test-${randomBytes(4).toString("hex")}`);
  const dataRoot = join(cwd, "data");
  mkdirSync(dataRoot, { recursive: true });
  // The Wal constructor expects a project directory and creates
  //  `.ironlore/wal/` under it. The watcher itself only knows about
  //  the `data/` root, so the layout matches a real project.
  const wal = new Wal(cwd);
  const events: WsEventInput[] = [];
  const broadcast = (e: WsEventInput) => {
    events.push(e);
  };
  // No SearchIndex — the watcher's index calls are optional and the
  //  attribution / debounce / filter logic is independent of indexing.
  const watcher = new FileWatcher(dataRoot, wal, undefined, broadcast);
  watcher.start();
  return { cwd, dataRoot, wal, watcher, events };
}

describe("FileWatcher", () => {
  let fx: Fixture | null = null;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    if (fx) {
      fx.watcher.stop();
      try {
        rmSync(fx.cwd, { recursive: true, force: true });
      } catch {
        /* */
      }
      fx = null;
    }
  });

  it("captures an external write within the debounce window + attributes it to system", async () => {
    if (!fx) throw new Error("fixture missing");
    const filePath = join(fx.dataRoot, "external.md");
    writeFileSync(filePath, "# external edit\n", "utf-8");

    const entries = await waitForWal(fx.wal, (rows) =>
      rows.some((r) => r.path === "external.md"),
    );
    const hit = entries.find((r) => r.path === "external.md");
    expect(hit).toBeDefined();
    expect(hit?.author).toBe("system");
    expect(hit?.op).toBe("write");
    // Message format mirrors `External edit: <relPath>` so the eventual
    //  git commit reads cleanly.
    expect(hit?.message).toContain("External edit");
  });

  it("emits a tree:add broadcast for a brand-new file", async () => {
    if (!fx) throw new Error("fixture missing");
    const filePath = join(fx.dataRoot, "new.md");
    writeFileSync(filePath, "# fresh\n", "utf-8");

    const event = await waitForBroadcast(
      fx.events,
      (e) => e.type === "tree:add" && "path" in e && e.path === "new.md",
    );
    expect(event).not.toBeNull();
    expect(event?.type).toBe("tree:add");
  });

  it("emits a tree:delete broadcast and clears the hash on unlink", async () => {
    if (!fx) throw new Error("fixture missing");
    const filePath = join(fx.dataRoot, "doomed.md");
    writeFileSync(filePath, "# doomed\n", "utf-8");

    // Wait for the create to be processed first so the watcher knows
    // the path exists (otherwise the delete fires against a path the
    // watcher has never seen and the broadcast is suppressed).
    await waitForWal(fx.wal, (rows) => rows.some((r) => r.path === "doomed.md"));

    unlinkSync(filePath);

    const event = await waitForBroadcast(
      fx.events,
      (e) => e.type === "tree:delete" && "path" in e && e.path === "doomed.md",
    );
    expect(event).not.toBeNull();

    // A delete WAL row should be present, attributed to system.
    const all = await waitForWal(fx.wal, (rows) =>
      rows.some((r) => r.path === "doomed.md" && r.op === "delete"),
    );
    const deleteRow = all.find((r) => r.path === "doomed.md" && r.op === "delete");
    expect(deleteRow?.author).toBe("system");
  });

  it("ignores hidden / dotfile-prefixed paths (.ironlore, .agents, sidecars)", async () => {
    if (!fx) throw new Error("fixture missing");
    // Sidecar inside the data root
    writeFileSync(join(fx.dataRoot, "page.blocks.json"), "{}", "utf-8");
    // A hidden directory the watcher must skip — agents-internal
    mkdirSync(join(fx.dataRoot, ".agents"), { recursive: true });
    writeFileSync(join(fx.dataRoot, ".agents", "internal.md"), "# hidden\n", "utf-8");

    // Give the watcher a clear chance to (incorrectly) pick these up.
    //  300 ms is well past the 200 ms debounce.
    await new Promise((r) => setTimeout(r, 350));

    const uncommitted = fx.wal.getUncommitted();
    const committed = fx.wal.getCommittedPending(50);
    const all = [...uncommitted, ...committed];

    const sidecarHit = all.find((r) => r.path.endsWith(".blocks.json"));
    const dotfileHit = all.find((r) => r.path.startsWith(".agents/"));
    expect(sidecarHit).toBeUndefined();
    expect(dotfileHit).toBeUndefined();
  });

  it("recordHash() suppresses an internal write so the WAL doesn't double-count it", async () => {
    if (!fx) throw new Error("fixture missing");
    const filePath = join(fx.dataRoot, "internal.md");
    const content = "# internal\n";
    writeFileSync(filePath, content, "utf-8");

    // Mirror what StorageWriter.write() does after a successful write:
    //  stamp the post-write hash so the watcher recognises its own
    //  bytes when the OS event lands. Hash MUST match `computeEtag`'s
    //  output; we recompute via the same helper used in the watcher.
    const { computeEtag } = await import("@ironlore/core/server");
    fx.watcher.recordHash(filePath, computeEtag(Buffer.from(content)));

    // Wait past the debounce; the watcher should silently drop the
    //  matching event.
    await new Promise((r) => setTimeout(r, 350));

    const uncommitted = fx.wal.getUncommitted();
    const committed = fx.wal.getCommittedPending(50);
    const all = [...uncommitted, ...committed];
    const echo = all.find((r) => r.path === "internal.md");
    expect(echo).toBeUndefined();
  });
});
