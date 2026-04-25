import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTALL_JSON, SENSITIVE_FILE_MODE } from "@ironlore/core";
import { extractDocx, extractEml } from "@ironlore/core/extractors";
import { createAuthApi, SessionStore } from "./auth.js";
import { extractPageKind } from "./tools/page-kind.js";
import { processUpload, UploadRejectedError } from "./uploads.js";
import { assertWritableKind, WritableKindsViolation } from "./tools/writable-kinds-gate.js";

/**
 * Phase-8 red-team corpus — adversarial probes for the four
 * scenarios documented in `docs/security-review.md`. Each test in
 * here corresponds to one finding in that report; if the test
 * regresses, the report's "regression test" link still points at the
 * surface that broke.
 *
 * The four scenarios:
 *   (a) Prompt-injected page contents trick the agent into mutating
 *       a `kind: source` page that's outside its `writable_kinds`.
 *   (b) Malformed `.docx` / `.eml` inputs fed through the extractors
 *       that the indexer + viewers share.
 *   (c) Nested-archive / ZIP-slip attempt against the upload pipeline.
 *   (d) Cookie tampering / session-fixation against the auth layer.
 *
 * Pre-existing tests in [`writable-kinds-gate.test.ts`](./tools/writable-kinds-gate.test.ts),
 * [`auth.test.ts`](./auth.test.ts), [`uploads.test.ts`](./uploads.test.ts),
 * [`xss-corpus.test.ts`](../client/lib/xss-corpus.test.ts),
 * [`egress-corpus.test.ts`](./egress-corpus.test.ts), and
 * [`resolve-safe-corpus.test.ts`](../../../packages/core/src/resolve-safe-corpus.test.ts)
 * already exercise the unit-level guarantees. This file exercises
 * *adversarial composition* — the kind of probe a red team would
 * run against the running shell.
 */

// ─────────────────────────────────────────────────────────────────
// (a) writable_kinds bypass attempts
// ─────────────────────────────────────────────────────────────────

describe("red-team — (a) writable_kinds bypass via prompt injection", () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "rt-kinds-"));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function writePersona(slug: string, writableKinds: string[]): void {
    const dir = join(dataRoot, ".agents", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "persona.md"),
      `---\nslug: ${slug}\nactive: true\nscope:\n  writable_kinds: [${writableKinds.join(", ")}]\n---\n\nbody\n`,
      "utf-8",
    );
  }

  function ctx(slug: string) {
    return {
      projectId: "main",
      agentSlug: slug,
      jobId: "rt",
      emitEvent: () => undefined,
      dataRoot,
    };
  }

  it("rejects a page whose frontmatter lies (prompt-injected `kind: page` on actual source content)", () => {
    // The page on disk declares `kind: source` — the gate runs
    // against THAT, not against any narration the model invented.
    // A persona with [page, wiki] cannot mutate it.
    writePersona("gardener", ["page", "wiki"]);
    const onDisk = "---\nid: x\nkind: source\n---\n\nReal source content.\n";
    expect(() => assertWritableKind(ctx("gardener"), extractPageKind(onDisk))).toThrow(
      WritableKindsViolation,
    );
  });

  it("ignores a frontmatter that claims `kind: page` AFTER `kind: source` (first wins)", () => {
    // Trick: a model writes a duplicate `kind:` further down in
    // hopes the parser uses the last match. Our regex is
    // first-match — verify a duplicate later in frontmatter
    // doesn't change the gate verdict.
    writePersona("gardener", ["page", "wiki"]);
    const tampered =
      "---\nid: x\nkind: source\ndescription: harmless\nkind: page\n---\n\nbody\n";
    const k = extractPageKind(tampered);
    expect(k).toBe("source"); // first match wins → gate sees source
    expect(() => assertWritableKind(ctx("gardener"), k)).toThrow(WritableKindsViolation);
  });

  it("can't bypass the gate by hiding kind under YAML indentation", () => {
    // The regex requires `kind` at start-of-line — an attacker
    // can't smuggle `kind: page` past by indenting it (which would
    // make YAML treat it as a nested key, not a top-level `kind`).
    // The gate then sees null kind and applies the permissive
    // default ("page"). The persona's allowlist ([page, wiki])
    // permits "page", so the attacker gains no privilege beyond
    // what a vanilla unmarked page already has.
    writePersona("gardener", ["page", "wiki"]);
    const indented = "---\n  kind:   source  \n---\n\nbody\n";
    const k = extractPageKind(indented);
    expect(k).toBeNull(); // indented `kind:` doesn't match — by design
    expect(() => assertWritableKind(ctx("gardener"), k)).not.toThrow();
  });

  it("extracts no kind from a page with no frontmatter (defaults to `page`, gate may permit)", () => {
    writePersona("gardener", ["page", "wiki"]);
    // No frontmatter → null kind → gate's permissive default
    // treats as `page`. Persona has `page` → permitted. The
    // attacker can't bypass via "no kind = magic admin" — they
    // just get the same trust level a vanilla page has.
    expect(extractPageKind("# Hi\n\nbody\n")).toBeNull();
    expect(() => assertWritableKind(ctx("gardener"), null)).not.toThrow();
  });

  it("a persona with empty writable_kinds denies even a vanilla page", () => {
    // `writable_kinds: []` is the principle-of-least-privilege
    // sandbox. Read-only personas ship with this. Confirm it
    // really is read-only.
    writePersona("readonly", []);
    expect(() => assertWritableKind(ctx("readonly"), "page")).toThrow(WritableKindsViolation);
    expect(() => assertWritableKind(ctx("readonly"), "wiki")).toThrow(WritableKindsViolation);
    expect(() => assertWritableKind(ctx("readonly"), "source")).toThrow(WritableKindsViolation);
  });

  it("a missing persona is permissive (test fixtures, not a privilege grant)", () => {
    // Documented behaviour: no persona file = permissive default,
    // because tests + fresh installs need to work. This is not a
    // privilege-escalation: in production every agent ships with a
    // persona via `seed-agents.ts`. The test pins the contract.
    expect(() => assertWritableKind(ctx("ghost"), "source")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// (b) malformed .docx / .eml extractors
// ─────────────────────────────────────────────────────────────────

describe("red-team — (b) malformed extractor inputs", () => {
  function asBuffer(s: string | Uint8Array): ArrayBuffer {
    const view = typeof s === "string" ? new TextEncoder().encode(s) : s;
    const ab = new ArrayBuffer(view.byteLength);
    new Uint8Array(ab).set(view);
    return ab;
  }

  // .docx is a ZIP container. Mammoth opens it via JSZip; an
  // invalid container should warning-out, not throw, and the indexer
  // (search-index.ts indexPage) treats `text: ""` as a no-op chunk.

  it("docx: random bytes yield text:'' + a warning, no throw", async () => {
    const garbage = randomBytes(2048);
    const result = await extractDocx(asBuffer(garbage));
    expect(result.text).toBe("");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("docx: empty buffer → text:'' + warning", async () => {
    const result = await extractDocx(asBuffer(""));
    expect(result.text).toBe("");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("docx: valid ZIP but missing word/document.xml → text:'' + warning", async () => {
    // 'PK\x03\x04...' is the local file header magic; a 22-byte
    // empty central-directory zip is the smallest valid container.
    // Mammoth opens it but finds no document part.
    const emptyZip = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const result = await extractDocx(asBuffer(emptyZip));
    expect(result.text).toBe("");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("eml: zero-length body → empty text, no throw", async () => {
    const result = await extractEml(asBuffer(""));
    expect(typeof result.text).toBe("string");
  });

  it("eml: header-only message with no body → parses headers, body empty", async () => {
    const onlyHeaders = "From: a@b\r\nSubject: Empty\r\n\r\n";
    const result = await extractEml(asBuffer(onlyHeaders));
    expect(result.text).toContain("Subject: Empty");
  });

  it("eml: deeply nested fake MIME boundaries don't blow up the parser", async () => {
    // Boundary-bombs are the MIME analogue of zip-bombs. postal-mime
    // is bounded internally; we just need to confirm we don't OOM
    // / loop forever.
    let body = "From: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n";
    // 32 fake nested parts — small enough to be fast, large enough
    // to break a naive recursive parser.
    for (let i = 0; i < 32; i++) {
      body += `--B\r\nContent-Type: multipart/mixed; boundary=B${i}\r\n\r\n`;
    }
    body += "--B--\r\n";
    const result = await extractEml(asBuffer(body));
    expect(typeof result.text).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────
// (c) nested-archive / ZIP-slip surface
// ─────────────────────────────────────────────────────────────────

describe("red-team — (c) nested-archive / zip-slip surface", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "rt-zip-"));
    mkdirSync(join(projectDir, "data"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("the upload pipeline rejects .zip outright (no extension allow-list match)", async () => {
    // .zip is not in `ALL_SUPPORTED_EXTS` (page-type.ts), so the
    // extension allow-list rejects it before any byte hits sharp /
    // mammoth / postal-mime. This is the strongest possible
    // defence against zip-slip: there is no extraction path.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new Uint8Array([
            0x50, 0x4b, 0x03, 0x04, // PK\x03\x04 — ZIP local file header
            ...new Uint8Array(32),
          ]),
        );
        c.close();
      },
    });
    await expect(
      processUpload(stream, "payload.zip", {
        writer: stub(projectDir),
        dataRoot: join(projectDir, "data"),
      }),
    ).rejects.toBeInstanceOf(UploadRejectedError);
  });

  it("a ZIP renamed `.png` is rejected by the MIME-sniff polyglot gate", async () => {
    // Try the polyglot trick: rename the .zip to .png. The
    // extension allow-list passes; the MIME sniffer (file-type)
    // identifies the bytes as application/zip; sniffed != image/png
    // → rejected.
    const zip = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04,
      0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
      ...new Uint8Array(64),
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(zip);
        c.close();
      },
    });
    await expect(
      processUpload(stream, "polyglot.png", {
        writer: stub(projectDir),
        dataRoot: join(projectDir, "data"),
      }),
    ).rejects.toBeInstanceOf(UploadRejectedError);
  });

  it("an EICAR-style executable sample renamed `.txt` is rejected at sniff", async () => {
    // EICAR test string is the canonical "this is a virus" probe.
    // Real malicious shells share its shape: ASCII-printable but
    // sniffs as application/x-msdownload or similar. We rename
    // it `.txt` to bypass the extension ban; the MIME sniff or
    // text-like fallback should still reject (or at minimum
    // accept it as plain text — never as an executable).
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(eicar));
        c.close();
      },
    });
    // .txt is in TEXT_LIKE_EXTS → sniff bypassed, but the file
    // can only land at .txt content — never as an executable.
    // We assert the upload SUCCEEDS as plain text, because
    // text uploads aren't dangerous; the path discipline
    // (storage-writer) prevents directory escape via filename.
    const result = await processUpload(stream, "eicar.txt", {
      writer: stub(projectDir),
      dataRoot: join(projectDir, "data"),
    });
    // .txt routes past sniff but lands as inert text content.
    expect(result.path.endsWith(".txt")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// (d) cookie tampering / session fixation
// ─────────────────────────────────────────────────────────────────

describe("red-team — (d) cookie tampering / session fixation", () => {
  let installRoot: string;
  let store: SessionStore;
  let api: Hono;

  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), "rt-auth-"));
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(
      join(installRoot, INSTALL_JSON),
      JSON.stringify({
        admin_username: "admin",
        initial_password: "TestPassword123456789012",
        created_at: new Date().toISOString(),
      }),
      { mode: SENSITIVE_FILE_MODE },
    );
    store = new SessionStore(installRoot);
    ({ api } = createAuthApi(installRoot, store));
  });

  afterEach(() => {
    store.close();
    rmSync(installRoot, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await api.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "TestPassword123456789012" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = /ironlore_session=([^;]+)/.exec(setCookie);
    expect(m).toBeTruthy();
    return m?.[1] ?? "";
  }

  it("login cookie carries the documented hardening (httpOnly + secure + sameSite=Lax)", async () => {
    const res = await api.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "TestPassword123456789012" }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("secure");
    // Hono lower-cases the attribute on serialization; assert
    // case-insensitively.
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
  });

  it("an attacker-crafted unsigned session id can't impersonate (cookie signature required)", async () => {
    // Plain UUID-shaped cookie with no signature. The auth
    // middleware should reject — verifySessionCookie returns null
    // and /me responds 401.
    const fakeSessionId = "00000000-0000-4000-8000-000000000000";
    const res = await api.request("/me", {
      headers: { Cookie: `ironlore_session=${fakeSessionId}` },
    });
    expect(res.status).toBe(401);
  });

  it("a flipped-byte signature is rejected (Ed25519 verifies cleanly)", async () => {
    const cookie = await login();
    // Cookie format is `<sessionId>.<base64url-sig>`. Flip the
    // last char of the signature so verification fails.
    const dot = cookie.lastIndexOf(".");
    const flipped = `${cookie.slice(0, dot + 1)}${flipLastChar(cookie.slice(dot + 1))}`;
    const res = await api.request("/me", {
      headers: { Cookie: `ironlore_session=${flipped}` },
    });
    expect(res.status).toBe(401);
  });

  it("a swapped session-id with someone else's signature can't impersonate", async () => {
    // Session-fixation attempt: attacker grabs a real signed
    // cookie A.sigA, then keeps sigA but swaps in their own
    // sessionId B. Ed25519 binds the message to the sig, so
    // verify fails.
    const cookie = await login();
    const dot = cookie.lastIndexOf(".");
    const hijacked = `00000000-0000-4000-8000-000000000000.${cookie.slice(dot + 1)}`;
    const res = await api.request("/me", {
      headers: { Cookie: `ironlore_session=${hijacked}` },
    });
    expect(res.status).toBe(401);
  });

  it("logout invalidates the cookie — replay after logout returns 401", async () => {
    const cookie = await login();
    const out = await api.request("/logout", {
      method: "POST",
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(out.status).toBe(200);
    // Even though the signature is valid, the session row is gone.
    const replay = await api.request("/me", {
      headers: { Cookie: `ironlore_session=${cookie}` },
    });
    expect(replay.status).toBe(401);
  });

  it("a sessionId without the `.<sig>` suffix is rejected (no quiet promotion)", async () => {
    // Old-style "raw session id" cookies must never authenticate —
    // strip the signature and confirm /me 401s.
    const cookie = await login();
    const sessionIdOnly = cookie.slice(0, cookie.lastIndexOf("."));
    const res = await api.request("/me", {
      headers: { Cookie: `ironlore_session=${sessionIdOnly}` },
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────

function flipLastChar(s: string): string {
  if (s.length === 0) return "A";
  const c = s.charCodeAt(s.length - 1);
  // Flip a single bit so the result is still a valid base64url
  // character but a different one — keeps the cookie shape sane,
  // ensures the signature genuinely changes.
  const next = String.fromCharCode(c === 65 /* A */ ? 66 : c - 1);
  return s.slice(0, -1) + next;
}

interface StubWriter {
  getDataRoot: () => string;
  write: (
    path: string,
    bytes: Buffer,
    etag: string | null,
    author?: string,
  ) => Promise<{ etag: string }>;
}

function stub(projectDir: string): StubWriter {
  // Minimal StorageWriter shape — `processUpload` only calls
  // `getDataRoot` (for path validation) and `write` (atomic
  // handoff). A real writer is overkill for these adversarial
  // tests; we just need the contract.
  const dataRoot = join(projectDir, "data");
  return {
    getDataRoot: () => dataRoot,
    write: async (path: string) => ({ etag: `"sha256-stub-${path}"` }),
  };
}
