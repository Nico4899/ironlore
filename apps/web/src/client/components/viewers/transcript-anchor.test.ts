import { describe, expect, it } from "vitest";
import { timestampAnchor } from "./TranscriptViewer.js";

describe("timestampAnchor", () => {
  it("formats WebVTT HH:MM:SS.mmm", () => {
    expect(timestampAnchor("14:23:05.000")).toBe("ts_142305000");
    expect(timestampAnchor("00:00:01.234")).toBe("ts_000001234");
  });

  it("zero-pads short MM:SS.mmm by assuming hours=00", () => {
    expect(timestampAnchor("23:05.000")).toBe("ts_002305000");
  });

  it("normalizes SRT's comma separator to dot", () => {
    expect(timestampAnchor("01:02:03,456")).toBe("ts_010203456");
  });

  it("pads milliseconds shorter than 3 digits", () => {
    expect(timestampAnchor("00:00:00.5")).toBe("ts_000000500");
  });

  it("truncates milliseconds longer than 3 digits", () => {
    expect(timestampAnchor("00:00:00.1234")).toBe("ts_000000123");
  });
});
