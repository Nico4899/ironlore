import type { ExtractResult } from "./types.js";

/**
 * Extract text + sanitized-ready HTML from a .docx buffer.
 *
 * Uses mammoth for paragraph/heading/list fidelity. Mammoth runs in both
 * Node and the browser against the same ArrayBuffer input, so this
 * function is shared by server ingestion and the client viewer.
 */
export async function extractDocx(buffer: ArrayBuffer): Promise<ExtractResult> {
  const mammoth = await import("mammoth");
  const warnings: string[] = [];

  try {
    const [textResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ arrayBuffer: buffer }),
      mammoth.convertToHtml({ arrayBuffer: buffer }),
    ]);

    for (const w of textResult.messages) warnings.push(`text: ${w.message}`);
    for (const w of htmlResult.messages) warnings.push(`html: ${w.message}`);

    return {
      text: textResult.value,
      html: htmlResult.value,
      warnings,
    };
  } catch (err) {
    return {
      text: "",
      warnings: [`extract failed: ${(err as Error).message}`],
    };
  }
}
