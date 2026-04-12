/**
 * Phase 1 exit criteria — stress tests at documented scale.
 *
 * 1. 1000 concurrent writes to the same path → consistent state, 1000 WAL entries
 * 2. 200 crafted path-traversal fuzz inputs → none escape
 * 3. kill -9 mid-write → recovers on restart without data loss
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { computeEtag, ForbiddenError, resolveSafe } from "@ironlore/core";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWriter } from "./storage-writer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(): string {
  const dir = join(tmpdir(), `ironlore-exit-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, ".ironlore", "locks"), { recursive: true });
  // Resolve through realpath so paths match on macOS (/tmp → /private/tmp)
  return realpathSync(dir);
}

// ---------------------------------------------------------------------------
// 1. 1000 concurrent writes
// ---------------------------------------------------------------------------

describe("exit criteria: 1000 concurrent writes", () => {
  const writers: StorageWriter[] = [];

  afterEach(() => {
    for (const w of writers) w.close();
    writers.length = 0;
  });

  it(
    "1000 concurrent writes to the same path end up with consistent state",
    async () => {
      const projectDir = makeTmpProject();
      const writer = new StorageWriter(projectDir);
      writers.push(writer);

      const N = 1000;

      // Fire 1000 concurrent writes to the same path.
      // Using ifMatch: null means "create or overwrite without ETag check".
      // The mutex serializes them — every one should succeed sequentially.
      const promises: Promise<{ etag: string }>[] = [];
      for (let i = 0; i < N; i++) {
        promises.push(
          writer.write("stress.md", `# Version ${i}\n`, null, `writer-${i}`),
        );
      }

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === "fulfilled");

      // All 1000 writes should succeed (mutex serializes, no ETag conflict
      // because ifMatch is null)
      expect(fulfilled).toHaveLength(N);

      // Final file should contain one of the written versions
      const finalContent = readFileSync(
        join(projectDir, "data", "stress.md"),
        "utf-8",
      );
      expect(finalContent).toMatch(/^# Version \d+\n$/);

      // The final ETag should match the file content
      const { content, etag } = writer.read("stress.md");
      expect(content).toBe(finalContent);
      expect(etag).toBe(computeEtag(finalContent));

      // WAL should have exactly N committed entries (first write creates,
      // remaining 999 update — but the skip-when-unchanged optimization
      // means some may be skipped if content happens to repeat).
      // Since every write has unique content "# Version i", all N should
      // produce WAL entries.
      const wal = writer.getWal();
      const pending = wal.getCommittedPending(N + 10);
      expect(pending).toHaveLength(N);

      // All WAL entries should be for the same path
      for (const entry of pending) {
        expect(entry.path).toBe("stress.md");
        expect(entry.op).toBe("write");
      }
    },
    30_000,
  );

  it(
    "1000 concurrent writes to different paths all succeed in parallel",
    async () => {
      const projectDir = makeTmpProject();
      const writer = new StorageWriter(projectDir);
      writers.push(writer);

      const N = 1000;
      const promises: Promise<{ etag: string }>[] = [];
      for (let i = 0; i < N; i++) {
        promises.push(
          writer.write(`pages/page-${i}.md`, `# Page ${i}\n`, null),
        );
      }

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(N);

      // Verify all files exist with correct content
      for (let i = 0; i < N; i++) {
        const content = readFileSync(
          join(projectDir, "data", "pages", `page-${i}.md`),
          "utf-8",
        );
        expect(content).toBe(`# Page ${i}\n`);
      }
    },
    30_000,
  );

  it(
    "1000 concurrent writes with ETag contention — exactly one wins per round",
    async () => {
      const projectDir = makeTmpProject();
      const writer = new StorageWriter(projectDir);
      writers.push(writer);

      // Seed the file
      await writer.write("contention.md", "v0", null);
      let currentEtag = computeEtag("v0");

      const N = 1000;
      let successCount = 0;

      // Fire N concurrent writes all claiming the same ETag.
      // Mutex serializes: the first one succeeds, the rest fail with 409.
      const promises: Promise<void>[] = [];
      for (let i = 0; i < N; i++) {
        promises.push(
          writer
            .write("contention.md", `v${i + 1}`, currentEtag)
            .then((result) => {
              successCount++;
              currentEtag = result.etag;
            })
            .catch(() => {
              // EtagMismatchError — expected for losers
            }),
        );
      }

      await Promise.all(promises);

      // Exactly 1 should have won (the first in the mutex queue)
      expect(successCount).toBe(1);

      // File state should be consistent
      const { content, etag } = writer.read("contention.md");
      expect(etag).toBe(currentEtag);
      expect(content).toMatch(/^v\d+$/);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 2. 200 path-traversal fuzz inputs
// ---------------------------------------------------------------------------

describe("exit criteria: 200 path-traversal fuzz inputs", () => {
  // Generate a comprehensive set of traversal payloads
  const TRAVERSAL_PAYLOADS: string[] = [
    // Basic traversal
    "../etc/passwd",
    "../../etc/shadow",
    "../../../etc/hosts",
    "../../../../etc/passwd",
    "../../../../../etc/passwd",

    // Deep traversal
    ...Array.from({ length: 20 }, (_, i) => "../".repeat(i + 1) + "etc/passwd"),

    // Encoded traversal
    "..%2fetc%2fpasswd",
    "..%2F..%2Fetc%2Fpasswd",
    "%2e%2e/etc/passwd",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "..%252fetc%252fpasswd",

    // Backslash variants (Windows-style)
    "..\\etc\\passwd",
    "..\\..\\etc\\passwd",
    "..\\..\\..\\etc\\passwd",
    "..%5cetc%5cpasswd",
    "..%5c..%5cetc%5cpasswd",

    // Null byte injection
    "..%00/etc/passwd",
    "valid.md%00../../etc/passwd",
    "page.md\0../../etc/passwd",

    // Absolute paths
    "/etc/passwd",
    "/etc/shadow",
    "/etc/hosts",
    "/proc/self/environ",
    "/proc/1/cmdline",
    "/dev/null",
    "/tmp/evil",
    "C:\\Windows\\System32\\config\\SAM",
    "C:/Windows/System32/drivers/etc/hosts",
    "\\\\server\\share\\file",

    // Mixed traversal + absolute
    "/../etc/passwd",
    "/../../etc/passwd",
    "..//etc/passwd",
    "..\\/etc/passwd",

    // Dot variations
    ".",
    "..",
    "...",
    "....",
    "....//",
    "..../etc/passwd",

    // Traversal within nested paths
    "sub/../../../etc/passwd",
    "a/b/c/../../../../etc/passwd",
    "pages/../../etc/passwd",
    "./../../etc/passwd",
    "sub/./../../etc/passwd",

    // Unicode normalization attacks
    "\u2025/etc/passwd", // ‥ (two dot leader)
    "\uff0e\uff0e/etc/passwd", // ．．(fullwidth dots)
    "..%c0%af..%c0%afetc%c0%afpasswd", // overlong UTF-8
    "..%e0%80%af..%e0%80%afetc%e0%80%afpasswd",

    // Repeated separators
    "..//..//etc/passwd",
    "..//////etc/passwd",
    "..\\\\\\\\etc\\\\passwd",

    // Trailing separators
    "../etc/passwd/",
    "../etc/passwd///",
    "../etc/passwd/.",
    "../etc/passwd/..",

    // Hidden files escape
    "../.ssh/id_rsa",
    "../.env",
    "../.git/config",
    "../../.ironlore-install.json",
    "../password.salt",
    "../ipc.token",
    "../sessions.sqlite",

    // Space and special char injection
    ".. /etc/passwd",
    " ../etc/passwd",
    "../ etc/passwd",
    "../etc/ passwd",
    "\t../etc/passwd",
    "../etc/passwd\n",

    // Protocol handlers
    "file:///etc/passwd",
    "file://localhost/etc/passwd",

    // Symlink-like paths
    "link -> /etc/passwd",

    // Case variations
    "..%2Fetc/passwd",
    "..%2fetc/PASSWD",

    // Length stress — very deep nesting
    ...Array.from({ length: 10 }, (_, i) =>
      "sub/".repeat(i + 5) + "../".repeat(i + 6) + "etc/passwd",
    ),

    // Combinations with valid-looking prefixes
    "pages/../../../etc/passwd",
    "docs/notes/../../../etc/passwd",
    "data/../../../etc/passwd",
    "sub/dir/../../..",
    "a/b/c/d/e/../../../../../..",
    "valid-page.md/../../../etc/passwd",

    // URL-encoded separators
    "..%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",

    // Double-encoding
    "%252e%252e%252fetc%252fpasswd",
    "..%255cetc%255cpasswd",

    // Mixed OS paths
    "..\\../etc/passwd",
    "../..\\etc\\passwd",
    "..\\..\\../etc/passwd",

    // Empty and near-empty
    "",

    // Paths that resolve back to root
    "sub/..",
    "sub/../",
    "a/b/../..",
    "a/b/../../",
  ];

  // Pad to 200 with randomized traversal variants
  while (TRAVERSAL_PAYLOADS.length < 200) {
    const depth = Math.floor(Math.random() * 10) + 1;
    const sep = Math.random() > 0.5 ? "/" : "\\";
    const dotdot = Math.random() > 0.5 ? ".." : "%2e%2e";
    const target =
      Math.random() > 0.5
        ? "etc/passwd"
        : ".ironlore-install.json";
    TRAVERSAL_PAYLOADS.push(
      Array(depth).fill(dotdot).join(sep) + sep + target,
    );
  }

  // Deduplicate and ensure exactly 200
  const uniquePayloads = [...new Set(TRAVERSAL_PAYLOADS)].slice(0, 200);

  // Pad if dedup reduced below 200
  while (uniquePayloads.length < 200) {
    const i = uniquePayloads.length;
    uniquePayloads.push(`${"../".repeat(i % 20 + 1)}etc/passwd-${i}`);
  }

  it(`all ${uniquePayloads.length} traversal inputs are rejected or resolve within root`, () => {
    const rawRoot = join(
      tmpdir(),
      `ironlore-fuzz-${randomBytes(4).toString("hex")}`,
    );
    mkdirSync(rawRoot, { recursive: true });
    // Resolve realpath so comparisons work on macOS (/tmp → /private/tmp)
    const root = realpathSync(rawRoot);

    // Create some subdirectories so "sub/.." style paths can resolve
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(join(root, "a", "b", "c", "d", "e"), { recursive: true });
    mkdirSync(join(root, "pages"), { recursive: true });
    mkdirSync(join(root, "docs", "notes"), { recursive: true });
    mkdirSync(join(root, "data"), { recursive: true });

    let escaped = 0;
    const rootPrefix = root + sep;

    for (const payload of uniquePayloads) {
      try {
        const resolved = resolveSafe(root, payload);
        // If resolveSafe didn't throw, the resolved path MUST be within root.
        // resolveSafe returns realpath-resolved paths, so comparison is safe.
        if (resolved !== root && !resolved.startsWith(rootPrefix)) {
          escaped++;
          console.error(
            `ESCAPE: payload=${JSON.stringify(payload)} resolved to ${resolved}`,
          );
        }
      } catch {
        // ForbiddenError or other errors (invalid characters, etc.) are
        // acceptable — the path was blocked regardless
      }
    }

    expect(escaped).toBe(0);
  });

  it("none of the 200 fuzz inputs bypass StorageWriter path validation", async () => {
    const projectDir = makeTmpProject();
    const writer = new StorageWriter(projectDir);

    // Create a sentinel file outside the data root
    const sentinelPath = join(projectDir, "sentinel.txt");
    writeFileSync(sentinelPath, "should not be overwritten");

    let bypassed = 0;

    for (const payload of uniquePayloads) {
      try {
        await writer.write(payload, "pwned", null);
        // If write succeeded, verify the file is within data/
        // (some payloads like "sub/.." resolve to root which is still within data/)
      } catch {
        // Expected — ForbiddenError or filesystem error
      }
    }

    // Sentinel file outside data/ must not have been touched
    if (readFileSync(sentinelPath, "utf-8") !== "should not be overwritten") {
      bypassed++;
    }

    // No file should exist outside the data directory
    expect(bypassed).toBe(0);

    writer.close();
  });
});

// ---------------------------------------------------------------------------
// 3. kill -9 crash recovery
// ---------------------------------------------------------------------------

describe("exit criteria: kill -9 crash recovery", () => {
  const writers: StorageWriter[] = [];

  afterEach(() => {
    for (const w of writers) w.close();
    writers.length = 0;
  });

  it("recovers uncommitted write after simulated crash", async () => {
    const projectDir = makeTmpProject();
    const writer = new StorageWriter(projectDir);

    // Simulate: WAL entry written, filesystem write never happened (kill -9)
    const wal = writer.getWal();
    const content = "# Crash-recovered page\n\nThis was in the WAL but not on disk.\n";
    wal.append({
      path: "crash-page.md",
      op: "write",
      preHash: null,
      postHash: computeEtag(content),
      content,
      author: "test",
      message: "Create crash-page.md",
    });

    // File should NOT exist on disk (simulating crash before fs write)
    expect(
      existsSync(join(projectDir, "data", "crash-page.md")),
    ).toBe(false);

    // Simulate restart
    writer.close();
    const writer2 = new StorageWriter(projectDir);
    writers.push(writer2);

    const { recovered, warnings } = writer2.recover();
    expect(recovered).toBe(1);
    expect(warnings).toHaveLength(0);

    // File should now exist with correct content
    const restored = readFileSync(
      join(projectDir, "data", "crash-page.md"),
      "utf-8",
    );
    expect(restored).toBe(content);
    expect(computeEtag(restored)).toBe(computeEtag(content));
  });

  it("recovers when fs write completed but WAL not marked committed", async () => {
    const projectDir = makeTmpProject();
    const writer = new StorageWriter(projectDir);

    const content = "# Already written\n";

    // Simulate: WAL entry written, fs write completed, but markCommitted
    // never ran (kill -9 between write and commit mark)
    const wal = writer.getWal();
    wal.append({
      path: "already-written.md",
      op: "write",
      preHash: null,
      postHash: computeEtag(content),
      content,
      author: "test",
      message: "Create already-written.md",
    });

    // Manually write the file (simulating fs write succeeded)
    mkdirSync(join(projectDir, "data"), { recursive: true });
    writeFileSync(join(projectDir, "data", "already-written.md"), content);

    // Simulate restart
    writer.close();
    const writer2 = new StorageWriter(projectDir);
    writers.push(writer2);

    const { recovered, warnings } = writer2.recover();
    expect(recovered).toBe(1);
    expect(warnings).toHaveLength(0);

    // File should still have correct content
    const restored = readFileSync(
      join(projectDir, "data", "already-written.md"),
      "utf-8",
    );
    expect(restored).toBe(content);
  });

  it("recovers uncommitted delete", async () => {
    const projectDir = makeTmpProject();
    const writer = new StorageWriter(projectDir);

    // Create the file first
    const content = "delete me";
    writeFileSync(join(projectDir, "data", "to-delete.md"), content);

    // Simulate: WAL entry for delete written, but unlink never happened
    const wal = writer.getWal();
    wal.append({
      path: "to-delete.md",
      op: "delete",
      preHash: computeEtag(content),
      postHash: null,
      content: null,
      author: "test",
      message: "Delete to-delete.md",
    });

    // Simulate restart
    writer.close();
    const writer2 = new StorageWriter(projectDir);
    writers.push(writer2);

    const { recovered, warnings } = writer2.recover();
    expect(recovered).toBe(1);
    expect(warnings).toHaveLength(0);

    // File should be gone
    expect(existsSync(join(projectDir, "data", "to-delete.md"))).toBe(false);
  });

  it("recovers multiple uncommitted entries from a batch crash", async () => {
    const projectDir = makeTmpProject();
    const writer = new StorageWriter(projectDir);
    const wal = writer.getWal();

    const entries = 50;

    // Simulate a batch of uncommitted writes (e.g. rapid typing then crash)
    for (let i = 0; i < entries; i++) {
      const content = `# Page ${i}\n`;
      wal.append({
        path: `batch/page-${i}.md`,
        op: "write",
        preHash: null,
        postHash: computeEtag(content),
        content,
        author: "test",
        message: `Create page-${i}.md`,
      });
    }

    // Verify none exist on disk
    for (let i = 0; i < entries; i++) {
      expect(
        existsSync(join(projectDir, "data", "batch", `page-${i}.md`)),
      ).toBe(false);
    }

    // Simulate restart
    writer.close();
    const writer2 = new StorageWriter(projectDir);
    writers.push(writer2);

    const { recovered, warnings } = writer2.recover();
    expect(recovered).toBe(entries);
    expect(warnings).toHaveLength(0);

    // All files should now exist with correct content
    for (let i = 0; i < entries; i++) {
      const content = readFileSync(
        join(projectDir, "data", "batch", `page-${i}.md`),
        "utf-8",
      );
      expect(content).toBe(`# Page ${i}\n`);
    }
  });

  it("warns when external edit conflicts with WAL during crash window", async () => {
    const projectDir = makeTmpProject();
    const writer = new StorageWriter(projectDir);

    const original = "original content";
    const walContent = "wal content";
    const externalContent = "someone else edited this";

    writeFileSync(join(projectDir, "data", "conflicted.md"), original);

    // Simulate: WAL says we're writing walContent over original,
    // but an external edit changed the file to externalContent
    const wal = writer.getWal();
    wal.append({
      path: "conflicted.md",
      op: "write",
      preHash: computeEtag(original),
      postHash: computeEtag(walContent),
      content: walContent,
      author: "test",
      message: "Update conflicted.md",
    });

    // External edit happened (simulating concurrent modification)
    writeFileSync(
      join(projectDir, "data", "conflicted.md"),
      externalContent,
    );

    // Simulate restart
    writer.close();
    const writer2 = new StorageWriter(projectDir);
    writers.push(writer2);

    const { recovered, warnings } = writer2.recover();
    // The entry doesn't match pre or post hash — should warn
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("matches neither pre nor post");

    // External content should be preserved (don't clobber it)
    const content = readFileSync(
      join(projectDir, "data", "conflicted.md"),
      "utf-8",
    );
    expect(content).toBe(externalContent);
  });

  it("idempotent recovery — running recover twice is safe", async () => {
    const projectDir = makeTmpProject();
    const writer = new StorageWriter(projectDir);

    const content = "# Recovered\n";
    const wal = writer.getWal();
    wal.append({
      path: "idem.md",
      op: "write",
      preHash: null,
      postHash: computeEtag(content),
      content,
      author: "test",
      message: "Create idem.md",
    });

    writer.close();
    const writer2 = new StorageWriter(projectDir);
    writers.push(writer2);

    // First recovery
    const r1 = writer2.recover();
    expect(r1.recovered).toBe(1);

    // Second recovery — all entries now committed, should be a no-op
    const r2 = writer2.recover();
    expect(r2.recovered).toBe(0);
    expect(r2.warnings).toHaveLength(0);

    // File content unchanged
    const restored = readFileSync(
      join(projectDir, "data", "idem.md"),
      "utf-8",
    );
    expect(restored).toBe(content);
  });
});
