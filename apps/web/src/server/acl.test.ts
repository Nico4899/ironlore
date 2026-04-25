import { describe, expect, it } from "vitest";
import {
  ACL_DEFAULT,
  AclViolation,
  assertCanAccess,
  canAccess,
  parsePageAcl,
  stampOwner,
} from "./acl.js";

/**
 * Per-page ACL parser + gate — unit coverage. Wiring into HTTP
 * routes is exercised by `pages-api.test.ts`; this file pins the
 * parser semantics so a regex tweak that changes shape gets caught
 * before it ships.
 */

describe("parsePageAcl", () => {
  it("returns default ACL when frontmatter is missing", () => {
    expect(parsePageAcl("# Hello\n\nbody\n")).toEqual(ACL_DEFAULT);
  });

  it("returns default ACL when frontmatter has no acl key", () => {
    const md = "---\nid: x\ntitle: T\n---\n\nbody\n";
    expect(parsePageAcl(md)).toEqual({ owner: null, read: null, write: null });
  });

  it("parses owner from a top-level scalar", () => {
    const md = "---\nid: x\nowner: alice-uid\n---\n\nbody\n";
    expect(parsePageAcl(md).owner).toBe("alice-uid");
  });

  it("parses flow-style read + write lists", () => {
    const md = [
      "---",
      "id: x",
      "owner: alice",
      "acl:",
      "  read: [alice, bob, everyone]",
      "  write: [alice]",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    const acl = parsePageAcl(md);
    expect(acl.owner).toBe("alice");
    expect(acl.read).toEqual(["alice", "bob", "everyone"]);
    expect(acl.write).toEqual(["alice"]);
  });

  it("parses block-style read + write lists", () => {
    const md = [
      "---",
      "id: x",
      "acl:",
      "  read:",
      "    - alice",
      "    - bob",
      "  write:",
      "    - owner",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    const acl = parsePageAcl(md);
    expect(acl.read).toEqual(["alice", "bob"]);
    expect(acl.write).toEqual(["owner"]);
  });

  it("ignores `owner:` indented as a nested key (anti-spoof)", () => {
    // A model that tries to smuggle `  owner: malicious` under
    // some other key shouldn't escalate to the page's owner —
    // the regex requires `owner:` at start of line (no indent).
    const md = "---\nid: x\nmeta:\n  owner: malicious\n---\n\nbody\n";
    expect(parsePageAcl(md).owner).toBeNull();
  });
});

describe("canAccess", () => {
  it("read default = everyone (any user passes)", () => {
    expect(canAccess(ACL_DEFAULT, "u1", "alice", "read")).toBe(true);
  });

  it("write default = owner only (no owner = no writers)", () => {
    expect(canAccess(ACL_DEFAULT, "u1", "alice", "write")).toBe(false);
  });

  it("write default with owner set = owner only", () => {
    const acl = { owner: "u1", read: null, write: null };
    expect(canAccess(acl, "u1", "alice", "write")).toBe(true);
    expect(canAccess(acl, "u2", "bob", "write")).toBe(false);
  });

  it("explicit `everyone` in read list lets everyone read", () => {
    const acl = { owner: "u1", read: ["everyone"], write: ["alice"] };
    expect(canAccess(acl, "u2", "bob", "read")).toBe(true);
    expect(canAccess(acl, "u2", "bob", "write")).toBe(false);
  });

  it("`owner` in write list resolves against the owner field", () => {
    const acl = { owner: "u1", read: ["everyone"], write: ["owner"] };
    expect(canAccess(acl, "u1", "alice", "write")).toBe(true);
    expect(canAccess(acl, "u2", "bob", "write")).toBe(false);
  });

  it("matches usernames literally", () => {
    const acl = { owner: null, read: ["alice"], write: null };
    expect(canAccess(acl, "u1", "alice", "read")).toBe(true);
    expect(canAccess(acl, "u2", "bob", "read")).toBe(false);
  });
});

describe("assertCanAccess", () => {
  it("throws AclViolation on deny", () => {
    const acl = { owner: "u1", read: ["alice"], write: ["alice"] };
    expect(() => assertCanAccess(acl, "u2", "bob", "read")).toThrow(AclViolation);
    try {
      assertCanAccess(acl, "u2", "bob", "write");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AclViolation);
      const v = err as AclViolation;
      expect(v.status).toBe(403);
      expect(v.op).toBe("write");
      expect(v.username).toBe("bob");
    }
  });

  it("does not throw on allow", () => {
    const acl = { owner: "u1", read: null, write: null };
    expect(() => assertCanAccess(acl, "u1", "alice", "read")).not.toThrow();
    expect(() => assertCanAccess(acl, "u2", "bob", "read")).not.toThrow();
  });
});

describe("stampOwner", () => {
  it("inserts `owner: <userId>` into frontmatter when missing", () => {
    const md = "---\nid: x\ntitle: T\n---\n\nbody\n";
    const stamped = stampOwner(md, "alice-uid");
    expect(stamped).toContain("owner: alice-uid");
    expect(stamped).toContain("id: x");
    expect(stamped).toContain("body");
  });

  it("leaves an existing owner untouched (no hijacking)", () => {
    const md = "---\nid: x\nowner: alice\n---\n\nbody\n";
    const stamped = stampOwner(md, "bob");
    expect(stamped).toBe(md);
  });

  it("is a no-op on pages without frontmatter", () => {
    const md = "# Plain page\n\nbody\n";
    expect(stampOwner(md, "alice")).toBe(md);
  });
});
