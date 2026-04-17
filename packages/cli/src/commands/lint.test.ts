import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lint } from "./lint.js";

/**
 * `ironlore lint` CLI tests.
 *
 * Verifies category dispatch, --check validation, and the
 * report-only-without-fix behavior.
 */

describe("lint CLI", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("rejects unknown --check category with a helpful error", () => {
    expect(() => lint({ project: "main", check: "not-a-real-category" })).toThrow(
      "process.exit called",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown check category"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("index-consistency"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("accepts valid --check category (index-consistency)", () => {
    // Without --fix, it prints a hint message, does not actually reindex.
    expect(() =>
      lint({ project: "main", check: "index-consistency" }),
    ).not.toThrow();
    expect(
      logSpy.mock.calls.some((call) => String(call[0]).includes("index-consistency")),
    ).toBe(true);
  });

  it("accepts valid --check category (schema-migration)", () => {
    expect(() => lint({ project: "main", check: "schema-migration" })).not.toThrow();
  });

  it("accepts valid --check category (data-integrity)", () => {
    expect(() => lint({ project: "main", check: "data-integrity" })).not.toThrow();
  });

  it("runs all categories when no --check is specified", () => {
    expect(() => lint({ project: "main" })).not.toThrow();
    // All three section headers should print
    for (const cat of ["index-consistency", "schema-migration", "data-integrity"]) {
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes(`[${cat}]`))).toBe(
        true,
      );
    }
  });

  it("prints the --fix flag in the header when set", () => {
    expect(() => lint({ project: "main", fix: false, check: "schema-migration" })).not.toThrow();
    const headerCall = logSpy.mock.calls.find((call) =>
      String(call[0]).startsWith("\nironlore lint"),
    );
    expect(String(headerCall?.[0])).not.toContain("--fix");

    logSpy.mockClear();
    expect(() => lint({ project: "main", fix: true, check: "schema-migration" })).not.toThrow();
    const fixHeader = logSpy.mock.calls.find((call) =>
      String(call[0]).startsWith("\nironlore lint"),
    );
    expect(String(fixHeader?.[0])).toContain("--fix");
  });
});
