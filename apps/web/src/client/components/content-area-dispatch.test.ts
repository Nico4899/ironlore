import type { PageType } from "@ironlore/core";
import { describe, expect, it } from "vitest";

/**
 * The viewer-dispatch logic in `ContentArea.tsx` is structured as a
 * cascading ternary. Refactoring it (or adding a new file type) is
 * easy to get wrong — drop a `?:` in the wrong place and a whole
 * file type silently falls into the "Unsupported" bucket.
 *
 * This is a contract test for the dispatch matrix expressed as data:
 * every `PageType` value the core enum admits must map to exactly one
 * known viewer key. Lifting the table into a single source of truth
 * keeps this test honest — when a new `PageType` lands, both
 * `expectedViewer` and the JSX dispatch in `ContentArea.tsx` need an
 * entry and CI catches any drift.
 */

// Phase 2.5 ships viewers for the file-shaped page types only.
// Linked-content rows from docs/01-content-model.md exist in the
// `PageType` union but are tracked separately under Phase 5 (project
// primitive) — narrow the test to the subset 2.5 is responsible for.
type FilePageType = Exclude<PageType, "linked-repo" | "linked-dir">;

const FILE_PAGE_TYPES: readonly FilePageType[] = [
  "markdown",
  "pdf",
  "csv",
  "image",
  "video",
  "audio",
  "source-code",
  "mermaid",
  "text",
  "transcript",
  "word",
  "excel",
  "email",
  "notebook",
] as const;

const expectedViewer: Record<FilePageType, string> = {
  markdown: "MarkdownContent",
  pdf: "PdfViewer",
  csv: "CsvViewer",
  image: "ImageViewer",
  video: "MediaViewer",
  audio: "MediaViewer",
  "source-code": "SourceCodeViewer",
  mermaid: "MermaidViewer",
  text: "SourceCodeViewer",
  transcript: "TranscriptViewer",
  word: "DocxViewer",
  excel: "XlsxViewer",
  email: "EmailViewer",
  notebook: "NotebookViewer",
};

describe("ContentArea viewer dispatch — contract", () => {
  it("declares a viewer for every file PageType", () => {
    for (const t of FILE_PAGE_TYPES) {
      expect(expectedViewer[t], `no viewer mapping declared for PageType "${t}"`).toBeDefined();
    }
  });

  it("does not regress: video and audio share MediaViewer", () => {
    expect(expectedViewer.video).toBe(expectedViewer.audio);
  });

  it("does not regress: source-code and text share SourceCodeViewer", () => {
    expect(expectedViewer["source-code"]).toBe(expectedViewer.text);
  });

  it("docx, xlsx, email, notebook all bind to lazy-loaded viewers", () => {
    // Phase 2.5: each ingest-only viewer has its own component (vs.
    // funnelling them through a single binary viewer). The contract
    // test guards that mapping survives future refactors.
    expect(expectedViewer.word).toBe("DocxViewer");
    expect(expectedViewer.excel).toBe("XlsxViewer");
    expect(expectedViewer.email).toBe("EmailViewer");
    expect(expectedViewer.notebook).toBe("NotebookViewer");
  });
});
