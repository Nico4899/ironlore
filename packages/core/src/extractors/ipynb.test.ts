import { describe, expect, it } from "vitest";
import { extractIpynb } from "./ipynb.js";

function toBuffer(obj: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;
}

describe("extractIpynb", () => {
  it("extracts markdown and code cells with outputs", async () => {
    const nb = {
      cells: [
        {
          cell_type: "markdown",
          source: ["# Analysis\n", "\n", "Summary of quarterly results."],
        },
        {
          cell_type: "code",
          execution_count: 1,
          source: "import pandas as pd\ndf = pd.read_csv('data.csv')",
          outputs: [
            { output_type: "stream", name: "stdout", text: "Loaded 1200 rows\n" },
            { output_type: "execute_result", data: { "text/plain": "<DataFrame>" } },
          ],
        },
      ],
      metadata: { kernelspec: { language: "python", name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5,
    };

    const result = await extractIpynb(toBuffer(nb));

    expect(result.notebook).toHaveLength(2);
    expect(result.notebook?.[0]?.kind).toBe("markdown");
    expect(result.notebook?.[0]?.source).toContain("# Analysis");
    expect(result.notebook?.[1]?.kind).toBe("code");
    expect(result.notebook?.[1]?.executionCount).toBe(1);
    expect(result.notebook?.[1]?.outputs).toContain("Loaded 1200 rows\n");
    expect(result.notebookLanguage).toBe("python");
    expect(result.warnings).toEqual([]);

    // FTS-facing text contains both markdown content and code
    expect(result.text).toContain("quarterly results");
    expect(result.text).toContain("read_csv");
    expect(result.text).toContain("Loaded 1200 rows");
  });

  it("captures error outputs (ename/evalue)", async () => {
    const nb = {
      cells: [
        {
          cell_type: "code",
          source: "1/0",
          outputs: [
            {
              output_type: "error",
              ename: "ZeroDivisionError",
              evalue: "division by zero",
            },
          ],
        },
      ],
    };
    const result = await extractIpynb(toBuffer(nb));
    expect(result.text).toContain("ZeroDivisionError");
    expect(result.text).toContain("division by zero");
  });

  it("falls back to language_info when kernelspec.language is absent", async () => {
    const nb = {
      cells: [],
      metadata: { language_info: { name: "r" } },
    };
    const result = await extractIpynb(toBuffer(nb));
    expect(result.notebookLanguage).toBe("r");
  });

  it("returns empty result with a warning on non-JSON input", async () => {
    const buf = new TextEncoder().encode("not a notebook").buffer as ArrayBuffer;
    const result = await extractIpynb(buf);
    expect(result.text).toBe("");
    expect(result.notebook).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns when `cells` is missing but does not throw", async () => {
    const result = await extractIpynb(toBuffer({ nbformat: 4 }));
    expect(result.text).toBe("");
    expect(result.warnings.some((w) => w.includes("cells"))).toBe(true);
  });

  it("tolerates cell_type other than markdown/code (treats as raw)", async () => {
    const nb = {
      cells: [{ cell_type: "heading", source: "Old v3 heading cell" }],
    };
    const result = await extractIpynb(toBuffer(nb));
    expect(result.notebook?.[0]?.kind).toBe("raw");
    expect(result.notebook?.[0]?.source).toContain("Old v3 heading cell");
  });
});
