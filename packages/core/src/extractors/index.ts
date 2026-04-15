import type { ExtractableFormat, ExtractResult } from "./types.js";

export type { EmailHeaders, ExtractableFormat, ExtractedSheet, ExtractResult } from "./types.js";

/**
 * Dispatch to the right extractor. Heavy libraries are imported inside each
 * extractor, so bundlers can code-split on format.
 */
export async function extract(
  format: ExtractableFormat,
  buffer: ArrayBuffer,
): Promise<ExtractResult> {
  switch (format) {
    case "word": {
      const { extractDocx } = await import("./docx.js");
      return extractDocx(buffer);
    }
    case "excel": {
      const { extractXlsx } = await import("./xlsx.js");
      return extractXlsx(buffer);
    }
    case "email": {
      const { extractEml } = await import("./eml.js");
      return extractEml(buffer);
    }
  }
}

export { extractDocx } from "./docx.js";
export { extractEml } from "./eml.js";
export { extractXlsx } from "./xlsx.js";
