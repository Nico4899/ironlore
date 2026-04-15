import { describe, expect, it } from "vitest";
import { encodeCsv } from "./csv-encode.js";

describe("encodeCsv", () => {
  it("emits bare values when no quoting is needed", () => {
    expect(encodeCsv([["a", "b", "c"]])).toBe("a,b,c");
  });

  it("quotes cells containing a comma", () => {
    expect(encodeCsv([["a", "b,c", "d"]])).toBe('a,"b,c",d');
  });

  it("quotes cells containing newlines", () => {
    expect(encodeCsv([["line1\nline2", "x"]])).toBe('"line1\nline2",x');
  });

  it("doubles embedded quotes and wraps", () => {
    expect(encodeCsv([['he said "hi"', "x"]])).toBe('"he said ""hi""",x');
  });

  it("joins rows with newlines", () => {
    expect(encodeCsv([["a", "b"], ["c", "d"]])).toBe("a,b\nc,d");
  });

  it("preserves empty cells", () => {
    expect(encodeCsv([["", "x", ""]])).toBe(",x,");
  });
});
