#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const projectDir = args[0];

if (!projectDir) {
  console.error("Usage: create-ironlore <directory>");
  console.error("");
  console.error("Example:");
  console.error("  npx create-ironlore@latest my-ironlore");
  process.exit(1);
}

const targetDir = resolve(projectDir);
const name = projectDir.split("/").pop() ?? "ironlore";

if (existsSync(targetDir)) {
  console.error(`Error: directory "${targetDir}" already exists.`);
  process.exit(1);
}

console.log(`Creating Ironlore project in ${targetDir}...`);
console.log("");

// Create directory structure
mkdirSync(join(targetDir, "projects", "main", "data"), { recursive: true });
mkdirSync(join(targetDir, "projects", "main", ".ironlore"), { recursive: true });

// Write package.json
writeFileSync(
  join(targetDir, "package.json"),
  JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        dev: "ironlore dev",
        start: "ironlore start",
        reindex: "ironlore reindex",
        migrate: "ironlore migrate",
        backup: "ironlore backup",
      },
      dependencies: {
        ironlore: "latest",
      },
    },
    null,
    2,
  ),
);

// Write project.yaml
writeFileSync(
  join(targetDir, "projects", "main", "project.yaml"),
  `preset: main
name: Main
egress:
  policy: allowlist
  allowlist:
    - "https://api.anthropic.com"
    - "https://api.openai.com"
`,
);

// Write .gitignore
writeFileSync(
  join(targetDir, ".gitignore"),
  `node_modules/
dist/
*.sqlite
*.sqlite-wal
*.sqlite-shm
projects/*/.ironlore/
.ironlore-install.json
ipc.token
*.enc
.env
.env.*
!.env.example
.DS_Store
`,
);

console.log("  Created package.json");
console.log("  Created projects/main/project.yaml");
console.log("  Created .gitignore");
console.log("");
console.log("Next steps:");
console.log(`  cd ${projectDir}`);
console.log("  pnpm install");
console.log("  pnpm dev");
console.log("");
console.log("The admin password will be printed on first run.");
console.log("Save it — it will not be shown again.");
