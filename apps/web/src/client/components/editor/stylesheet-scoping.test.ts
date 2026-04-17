import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Stylesheet scoping test.
 *
 * docs/03-editor.md §Stylesheet scoping requires:
 *
 *   "ProseMirror editor styles live in a scoped stylesheet (editor.css)
 *    co-located with the editor component — not in a global CSS block.
 *    A lint rule bans .ProseMirror selectors outside the editor directory."
 *
 * Biome doesn't have a native CSS-selector rule, so we enforce the
 * boundary via this test — it walks every .css file under the client
 * tree and fails if any file outside `components/editor/` mentions
 * `.ProseMirror`. The rule keeps the editor's typography hermetic
 * so a dark-mode tweak in globals.css can't silently reshape the
 * editor body.
 */

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = dirname(THIS_FILE);
const CLIENT_ROOT = resolve(THIS_DIR, "../.."); // apps/web/src/client
const EDITOR_DIR = resolve(THIS_DIR); // apps/web/src/client/components/editor

function collectCss(dir: string, out: string[] = []): string[] {
  const entries = readdirSync(dir);
  for (const name of entries) {
    const full = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      collectCss(full, out);
    } else if (name.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

function insideEditorDir(filePath: string): boolean {
  return filePath.startsWith(`${EDITOR_DIR}${join("/")}`) || filePath.startsWith(EDITOR_DIR + "/");
}

describe("Stylesheet scoping — .ProseMirror selectors", () => {
  it("only the editor directory contains .ProseMirror selectors", () => {
    const files = collectCss(CLIENT_ROOT);
    // Sanity: we actually found some CSS files.
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      if (insideEditorDir(file)) continue;
      const content = readFileSync(file, "utf-8");
      // `.ProseMirror` as a CSS class selector. Bare-word boundary
      // check so comments mentioning ProseMirror in prose don't trip.
      // We look for the leading dot + class name followed by a non-word char.
      if (/\.ProseMirror\b/.test(content)) {
        violations.push(file.replace(CLIENT_ROOT, "<client>"));
      }
    }

    expect(violations).toEqual([]);
  });

  it("editor.css exists and contains the base .ProseMirror selector", () => {
    const editorCss = join(EDITOR_DIR, "editor.css");
    const content = readFileSync(editorCss, "utf-8");
    expect(content).toMatch(/\.ProseMirror\s*\{/);
  });
});
