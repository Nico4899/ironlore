import { z } from "zod";
import { FRONTMATTER_SCHEMA_VERSION } from "./constants.js";

/** Zod schema for page frontmatter. */
export const PageFrontmatterSchema = z.object({
  schema: z.number().int().default(FRONTMATTER_SCHEMA_VERSION),
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["page", "source", "wiki"]).optional(),
  created: z.string().datetime(),
  modified: z.string().datetime(),
  tags: z.array(z.string()).optional(),
  icon: z.string().optional(),
  source_id: z.string().optional(),
  acl: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Zod schema for project.yaml. */
export const ProjectConfigSchema = z.object({
  kind: z.enum(["main", "research", "sandbox"]),
  name: z.string().min(1),
  egress: z
    .object({
      policy: z.enum(["open", "allowlist", "blocked"]),
      allowlist: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Zod schema for the bootstrap install record. */
export const InstallRecordSchema = z.object({
  admin_username: z.string().min(1),
  initial_password: z.string().min(24),
  created_at: z.string().datetime(),
});
