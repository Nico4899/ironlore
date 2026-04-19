import { ForbiddenError } from "@ironlore/core/server";
import busboy from "busboy";
import { Hono } from "hono";
import type { StorageWriter } from "./storage-writer.js";
import {
  bufferStreamWithCap,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  processUpload,
  UploadRejectedError,
  type UploadResult,
} from "./uploads.js";

/**
 * Multipart upload API — `POST /api/projects/:id/uploads` accepts
 * `multipart/form-data` with one or more `file` parts (field name is
 * conventional, any name works) and an optional `dir` text field that
 * specifies the target subdirectory inside `data/`. Streaming via
 * busboy means a 10 GB request hits the cap before we've buffered
 * more than `maxFileBytes` of any single file.
 *
 * Each file runs through `processUpload` (uploads.ts) which enforces
 * the seven gates documented in docs/05-jobs-and-security.md §Upload
 * pipeline. Failures are per-file so a single bad polyglot doesn't
 * tank a legitimate batch upload.
 *
 * Response shape mirrors the per-file pipeline result plus a
 * `rejected` array of `{ filename, code, message }` for files the
 * pipeline refused.
 */
export function createUploadsApi(writer: StorageWriter, dataRoot: string): Hono {
  const api = new Hono();

  api.post("/", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return c.json({ error: "Expected multipart/form-data" }, 415);
    }

    // Cap the full request at 200 MB regardless of per-file size. The
    //  per-file cap stacks on top — smallest limit wins.
    const accepted: UploadResult[] = [];
    const rejected: Array<{ filename: string; code: string; message: string }> = [];
    let targetDir = "";
    let totalBytes = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const bb = busboy({
          headers: {
            "content-type": contentType,
            "content-length": c.req.header("content-length"),
          },
          limits: {
            fileSize: DEFAULT_MAX_FILE_BYTES,
            files: 32,
            fields: 8,
          },
        });

        // Collect scalar fields (dir, etc.) first — busboy fires them
        //  in parse order so we latch the value and use it when the
        //  file parts arrive.
        bb.on("field", (name, value) => {
          if (name === "dir" && typeof value === "string") {
            targetDir = value.trim();
          }
        });

        const inflight: Array<Promise<void>> = [];

        bb.on("file", (_fieldname, stream, info) => {
          const { filename, mimeType } = info;
          // Enforce the per-request cap by observing each chunk. We
          //  only buffer up to the file cap, so the running total
          //  cannot exceed files × maxFileBytes regardless.
          const p = (async () => {
            try {
              const buf = await bufferStreamWithCap(stream, DEFAULT_MAX_FILE_BYTES);
              totalBytes += buf.byteLength;
              if (totalBytes > DEFAULT_MAX_REQUEST_BYTES) {
                rejected.push({
                  filename,
                  code: "request_too_large",
                  message: `Request exceeds ${DEFAULT_MAX_REQUEST_BYTES} byte cap`,
                });
                return;
              }
              const result = await processUpload(filename, mimeType, buf, writer, dataRoot, {
                targetDir,
              });
              accepted.push(result);
            } catch (err) {
              if (err instanceof UploadRejectedError) {
                rejected.push({ filename, code: err.code, message: err.message });
                return;
              }
              if (err instanceof ForbiddenError) {
                rejected.push({
                  filename,
                  code: "forbidden",
                  message: "Path escapes project root",
                });
                return;
              }
              // Unknown error — resume the stream and record.
              rejected.push({
                filename,
                code: "internal",
                message: err instanceof Error ? err.message : String(err),
              });
            } finally {
              // Drain residual bytes if we rejected mid-stream so
              //  busboy can finish parsing the request.
              stream.resume();
            }
          })();
          inflight.push(p);
        });

        bb.on("close", () => {
          Promise.all(inflight)
            .then(() => resolve())
            .catch(reject);
        });
        bb.on("error", (err: Error) => reject(err));

        // Pipe the Hono/Web Request body into busboy. Hono exposes a
        //  `ReadableStream` via `c.req.raw.body`; we feed chunks in a
        //  small pump rather than bringing in another adapter lib.
        const bodyStream = c.req.raw.body;
        if (!bodyStream) {
          reject(new Error("Request had no body"));
          return;
        }
        (async () => {
          const reader = bodyStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              bb.write(value);
            }
            bb.end();
          } catch (err) {
            reject(err as Error);
          }
        })();
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Upload parse failed" }, 400);
    }

    return c.json({ accepted, rejected });
  });

  return api;
}
