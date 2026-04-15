import { describe, expect, it } from "vitest";
import { getLanguageLabel, hasLanguageSupport } from "./SourceCodeViewer.js";

/**
 * Locks in the per-extension grammar table. The viewer's contract is:
 *
 *   - Every extension listed in docs/01-content-model.md gets *some*
 *     CodeMirror grammar (tested via `hasLanguageSupport`).
 *   - The toolbar label never invents a fake name from an unknown
 *     extension — it falls back to "Plain text" honestly.
 *
 * If the language map drifts (someone deletes a loader, splits an
 * extension off), this suite is the early-warning alarm.
 */

const SUPPORTED = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "sh",
  "bash",
  "zsh",
  "fish",
  "lua",
  "r",
  "sql",
  "yaml",
  "yml",
  "toml",
  "xml",
  "json",
  "html",
  "css",
  "scss",
  "md",
];

describe("source-code language map", () => {
  describe("hasLanguageSupport", () => {
    for (const ext of SUPPORTED) {
      it(`recognizes .${ext}`, () => {
        expect(hasLanguageSupport(`file.${ext}`)).toBe(true);
      });
    }

    it("returns false for unknown extensions", () => {
      expect(hasLanguageSupport("Dockerfile")).toBe(false);
      expect(hasLanguageSupport("LICENSE")).toBe(false);
      expect(hasLanguageSupport("file.unknownext")).toBe(false);
    });

    it("returns false for php (no grammar packaged today)", () => {
      // Documenting the gap so adding `@codemirror/lang-php` later is
      // an obvious test diff.
      expect(hasLanguageSupport("script.php")).toBe(false);
    });
  });

  describe("getLanguageLabel", () => {
    it("returns the human label for known extensions", () => {
      expect(getLanguageLabel("a.ts")).toBe("TypeScript");
      expect(getLanguageLabel("a.py")).toBe("Python");
      expect(getLanguageLabel("a.go")).toBe("Go");
      expect(getLanguageLabel("a.rs")).toBe("Rust");
      expect(getLanguageLabel("a.yaml")).toBe("YAML");
    });

    it("falls back to 'Plain text' for unknown extensions", () => {
      // The previous implementation returned the upper-cased extension
      // ("XYZ", "DOCKERFILE"), implying highlighting that wasn't
      // actually applied. The honest fallback is "Plain text".
      expect(getLanguageLabel("file.xyz")).toBe("Plain text");
      expect(getLanguageLabel("Dockerfile")).toBe("Plain text");
      expect(getLanguageLabel("README")).toBe("Plain text");
    });

    it("treats extensions case-insensitively", () => {
      expect(getLanguageLabel("FILE.TS")).toBe("TypeScript");
      expect(getLanguageLabel("Notes.MD")).toBe("Markdown");
    });
  });
});
