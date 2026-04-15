import type { EmailHeaders } from "@ironlore/core/extractors";
import { useEffect, useState } from "react";
import { fetchRawUrl } from "../../lib/api.js";

interface EmailViewerProps {
  path: string;
}

/**
 * .eml viewer.
 *
 * Renders parsed headers in a compact block and the body as plain text
 * in a monospaced pane. HTML-only messages are already down-converted to
 * text by the extractor so we never inject untrusted HTML here.
 */
export function EmailViewer({ path }: EmailViewerProps) {
  const [headers, setHeaders] = useState<EmailHeaders | null>(null);
  const [body, setBody] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHeaders(null);
    setBody("");

    (async () => {
      try {
        const res = await fetch(fetchRawUrl(path));
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        const { extract } = await import("@ironlore/core/extractors");
        const result = await extract("email", buf);
        if (cancelled) return;
        setHeaders(result.email ?? {});
        // `text` includes the header block for FTS. Strip it here so the
        // viewer doesn't double-render the headers.
        const sep = "\n\n";
        const bodyStart = result.text.indexOf(sep);
        const raw = bodyStart === -1 ? result.text : result.text.slice(bodyStart + sep.length);
        setBody(raw.replace(/^\s+/, ""));
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">Loading message...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">Failed to render: {error}</p>
      </div>
    );
  }

  const h = headers ?? {};
  const rows: Array<[string, string | undefined]> = [
    ["Subject", h.subject],
    ["From", h.from],
    ["To", h.to],
    ["Cc", h.cc],
    ["Date", h.date],
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-3">
        <table className="text-sm" role="presentation">
          <tbody>
            {rows
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <tr key={k}>
                  <th scope="row" className="pr-4 align-top text-xs font-normal text-secondary">
                    {k}
                  </th>
                  <td className="text-primary">{v}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap wrap-break-word px-6 py-4 font-mono text-sm text-primary">
        {body}
      </pre>
    </div>
  );
}
