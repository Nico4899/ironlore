import { describe, expect, it } from "vitest";
import { detectPageType, isSupportedExtension } from "./page-type.js";

describe("detectPageType", () => {
  it("detects markdown files", () => {
    expect(detectPageType("readme.md")).toBe("markdown");
    expect(detectPageType("notes/index.md")).toBe("markdown");
  });

  it("detects PDF files", () => {
    expect(detectPageType("paper.pdf")).toBe("pdf");
  });

  it("detects CSV files", () => {
    expect(detectPageType("data.csv")).toBe("csv");
  });

  it("detects image files", () => {
    expect(detectPageType("photo.png")).toBe("image");
    expect(detectPageType("photo.JPG")).toBe("image");
    expect(detectPageType("logo.svg")).toBe("image");
    expect(detectPageType("animation.gif")).toBe("image");
  });

  it("detects video files", () => {
    expect(detectPageType("clip.mp4")).toBe("video");
    expect(detectPageType("demo.webm")).toBe("video");
  });

  it("detects audio files", () => {
    expect(detectPageType("podcast.mp3")).toBe("audio");
    expect(detectPageType("recording.wav")).toBe("audio");
  });

  it("detects source code files", () => {
    expect(detectPageType("app.ts")).toBe("source-code");
    expect(detectPageType("main.py")).toBe("source-code");
    expect(detectPageType("lib.go")).toBe("source-code");
    expect(detectPageType("style.css")).toBe("source-code");
  });

  it("detects mermaid files", () => {
    expect(detectPageType("diagram.mermaid")).toBe("mermaid");
    expect(detectPageType("flow.mmd")).toBe("mermaid");
  });

  it("detects plain text files", () => {
    expect(detectPageType("notes.txt")).toBe("text");
    expect(detectPageType("server.log")).toBe("text");
  });

  it("detects transcript files", () => {
    expect(detectPageType("captions.vtt")).toBe("transcript");
    expect(detectPageType("subs.srt")).toBe("transcript");
  });

  it("detects office and email containers", () => {
    expect(detectPageType("spec.docx")).toBe("word");
    expect(detectPageType("budget.xlsx")).toBe("excel");
    expect(detectPageType("thread.eml")).toBe("email");
  });

  it("detects Jupyter notebooks", () => {
    expect(detectPageType("analysis.ipynb")).toBe("notebook");
    expect(detectPageType("nested/path/model.IPYNB")).toBe("notebook");
  });

  it("defaults to markdown for unknown extensions", () => {
    expect(detectPageType("unknown.xyz")).toBe("markdown");
  });

  it("defaults to markdown for directories", () => {
    expect(detectPageType("some-dir", true)).toBe("markdown");
  });
});

describe("isSupportedExtension", () => {
  it("returns true for recognized extensions", () => {
    expect(isSupportedExtension("readme.md")).toBe(true);
    expect(isSupportedExtension("data.csv")).toBe(true);
    expect(isSupportedExtension("photo.png")).toBe(true);
    expect(isSupportedExtension("clip.mp4")).toBe(true);
    expect(isSupportedExtension("song.mp3")).toBe(true);
    expect(isSupportedExtension("app.ts")).toBe(true);
    expect(isSupportedExtension("flow.mmd")).toBe(true);
    expect(isSupportedExtension("doc.pdf")).toBe(true);
    expect(isSupportedExtension("notes.txt")).toBe(true);
    expect(isSupportedExtension("captions.vtt")).toBe(true);
    expect(isSupportedExtension("spec.docx")).toBe(true);
    expect(isSupportedExtension("budget.xlsx")).toBe(true);
    expect(isSupportedExtension("thread.eml")).toBe(true);
    expect(isSupportedExtension("analysis.ipynb")).toBe(true);
  });

  it("returns false for unrecognized extensions", () => {
    expect(isSupportedExtension("file.xyz")).toBe(false);
    expect(isSupportedExtension("archive.zip")).toBe(false);
    expect(isSupportedExtension("binary.exe")).toBe(false);
  });

  it("returns false for files with no extension", () => {
    expect(isSupportedExtension("Makefile")).toBe(false);
    expect(isSupportedExtension(".gitignore")).toBe(false);
  });
});
