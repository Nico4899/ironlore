import { describe, expect, it } from "vitest";
import { PathMutex } from "./mutex.js";

describe("PathMutex", () => {
  it("serializes operations on the same key", async () => {
    const mutex = new PathMutex();
    const order: number[] = [];

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const p1 = mutex.withLock("a", async () => {
      await delay(50);
      order.push(1);
    });

    const p2 = mutex.withLock("a", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("allows parallel operations on different keys", async () => {
    const mutex = new PathMutex();
    const order: string[] = [];

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const p1 = mutex.withLock("a", async () => {
      await delay(50);
      order.push("a");
    });

    const p2 = mutex.withLock("b", async () => {
      order.push("b");
    });

    await Promise.all([p1, p2]);
    // "b" should finish first since it doesn't wait
    expect(order).toEqual(["b", "a"]);
  });

  it("releases lock on error", async () => {
    const mutex = new PathMutex();

    await expect(
      mutex.withLock("a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Should be able to acquire again
    let ran = false;
    await mutex.withLock("a", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("handles many concurrent locks on same key", async () => {
    const mutex = new PathMutex();
    const results: number[] = [];

    const tasks = Array.from({ length: 20 }, (_, i) =>
      mutex.withLock("key", async () => {
        results.push(i);
      }),
    );

    await Promise.all(tasks);
    expect(results).toHaveLength(20);
    // All 20 should have run, in sequential order
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
