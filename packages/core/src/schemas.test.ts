import { describe, expect, it } from "vitest";
import { PageFrontmatterSchema, ProjectConfigSchema, InstallRecordSchema } from "./schemas.js";

describe("PageFrontmatterSchema", () => {
  it("validates a minimal valid frontmatter", () => {
    const result = PageFrontmatterSchema.safeParse({
      id: "01HXYZ1234567890ABCDEFGHIJ",
      title: "Test Page",
      created: "2026-04-11T10:00:00Z",
      modified: "2026-04-11T10:30:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema).toBe(1); // default
      expect(result.data.kind).toBeUndefined();
    }
  });

  it("validates a full frontmatter", () => {
    const result = PageFrontmatterSchema.safeParse({
      schema: 1,
      id: "01HXYZ1234567890ABCDEFGHIJ",
      title: "Test Page",
      kind: "wiki",
      created: "2026-04-11T10:00:00Z",
      modified: "2026-04-11T10:30:00Z",
      tags: ["test", "example"],
      icon: "lucide:book",
      source_id: "01HABCDEFGHIJKLMNOPQRSTUV",
      acl: { read: ["alice"], write: ["alice"] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty title", () => {
    const result = PageFrontmatterSchema.safeParse({
      id: "01HXYZ1234567890ABCDEFGHIJ",
      title: "",
      created: "2026-04-11T10:00:00Z",
      modified: "2026-04-11T10:30:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid kind", () => {
    const result = PageFrontmatterSchema.safeParse({
      id: "01HXYZ",
      title: "Test",
      kind: "invalid",
      created: "2026-04-11T10:00:00Z",
      modified: "2026-04-11T10:30:00Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("ProjectConfigSchema", () => {
  it("validates a main project config", () => {
    const result = ProjectConfigSchema.safeParse({
      kind: "main",
      name: "Main",
    });
    expect(result.success).toBe(true);
  });

  it("validates a research project with egress", () => {
    const result = ProjectConfigSchema.safeParse({
      kind: "research",
      name: "Research",
      egress: {
        policy: "allowlist",
        allowlist: ["https://api.anthropic.com"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid project kind", () => {
    const result = ProjectConfigSchema.safeParse({
      kind: "invalid",
      name: "Test",
    });
    expect(result.success).toBe(false);
  });
});

describe("InstallRecordSchema", () => {
  it("validates a well-formed install record", () => {
    const result = InstallRecordSchema.safeParse({
      admin_username: "admin",
      initial_password: "aB3$dE6fG8hI0jK2lM4nO6pQ8",
      created_at: "2026-04-11T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a short password", () => {
    const result = InstallRecordSchema.safeParse({
      admin_username: "admin",
      initial_password: "short",
      created_at: "2026-04-11T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});
