import { useEffect, useMemo, useRef } from "react";

/**
 * Parse .vtt / .srt cues into `[timestamp, text]` rows.
 *
 * Both formats are line-oriented: a numeric or blank id line, a
 * `start --> end` timing line, then one or more text lines, blank
 * separator. We keep the start timestamp and concatenate body lines.
 */
interface Cue {
  time: string;
  /** Stable anchor ID: `ts_HHMMSSmmm` — used for in-page navigation and
   * wiki-link citation (`[[meeting.vtt#ts_142305000]]`). */
  anchor: string;
  text: string;
}

const TIMING_RE = /^(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*/;

/**
 * Convert a cue timestamp string into a stable anchor ID.
 *
 * Accepts `HH:MM:SS.mmm` (WebVTT) and `MM:SS.mmm` (shortened) and
 * returns `ts_HHMMSSmmm` where missing hours are zero-padded. Commas
 * are normalized to dots before splitting so SRT's `HH:MM:SS,mmm` also
 * works.
 */
export function timestampAnchor(time: string): string {
  const normalized = time.replace(",", ".");
  const [clock, ms = "000"] = normalized.split(".");
  const parts = (clock ?? "").split(":");
  const [hhRaw, mmRaw, ssRaw] = parts.length === 3 ? parts : ["00", parts[0] ?? "0", parts[1] ?? "0"];
  const hh = String(hhRaw ?? "0").padStart(2, "0");
  const mm = String(mmRaw ?? "0").padStart(2, "0");
  const ss = String(ssRaw ?? "0").padStart(2, "0");
  // Millisecond fraction — pad on the right (decimal expansion), not
  // left-pad: ".5" means 500ms, not 005ms.
  const mmm = ms.padEnd(3, "0").slice(0, 3);
  return `ts_${hh}${mm}${ss}${mmm}`;
}

function parseCues(raw: string): Cue[] {
  const blocks = raw.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const timingIdx = lines.findIndex((l) => TIMING_RE.test(l));
    if (timingIdx === -1) continue;
    const timingLine = lines[timingIdx] ?? "";
    const match = TIMING_RE.exec(timingLine);
    if (!match) continue;
    const time = (match[1] ?? "").replace(",", ".");
    const text = lines
      .slice(timingIdx + 1)
      .join(" ")
      .trim();
    if (text) cues.push({ time, anchor: timestampAnchor(time), text });
  }
  return cues;
}

interface TranscriptViewerProps {
  content: string;
  /** File path — used to generate `[[path#ts_...]]` citation strings. */
  path?: string;
}

export function TranscriptViewer({ content, path }: TranscriptViewerProps) {
  const cues = useMemo(() => parseCues(content), [content]);
  const tableRef = useRef<HTMLTableElement>(null);

  // Scroll to the `ts_...` anchor on mount if one is in the URL hash.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash || !hash.startsWith("ts_")) return;
    const row = tableRef.current?.querySelector(`[id="${CSS.escape(hash)}"]`);
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("bg-signal-amber/10");
      setTimeout(() => row.classList.remove("bg-signal-amber/10"), 1500);
    }
  }, []);

  const copyCitation = (anchor: string) => {
    const target = path ? `${path}#${anchor}` : anchor;
    const citation = `[[${target}]]`;
    navigator.clipboard?.writeText(citation).catch(() => {
      // Clipboard denied (non-secure context); fall back silently.
    });
  };

  if (cues.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">No cues found</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <table ref={tableRef} className="w-full border-collapse text-sm">
        <caption className="sr-only">Transcript ({cues.length} cues)</caption>
        <tbody>
          {cues.map((cue, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cues render-only, never reordered
            <tr
              key={`${cue.anchor}-${i}`}
              id={cue.anchor}
              className="border-b border-border align-top transition-colors"
            >
              <td className="w-32 py-1 pr-4 font-mono text-xs text-secondary">
                <a
                  href={`#${cue.anchor}`}
                  className="hover:underline"
                  aria-label={`Jump to cue at ${cue.time}`}
                  onClick={(e) => {
                    // Let the anchor update the URL, but also copy the
                    // wiki-link citation so users can paste it into a note.
                    if (e.altKey || e.metaKey) {
                      e.preventDefault();
                      copyCitation(cue.anchor);
                    }
                  }}
                >
                  {cue.time}
                </a>
              </td>
              <td className="py-1 text-primary">{cue.text}</td>
              <td className="w-8 py-1 text-right">
                <button
                  type="button"
                  aria-label={`Copy citation for ${cue.time}`}
                  className="rounded px-1 py-0.5 text-xs text-secondary opacity-0 hover:bg-ironlore-slate-hover group-hover:opacity-100 focus:opacity-100"
                  onClick={() => copyCitation(cue.anchor)}
                  title="Copy [[path#anchor]] citation"
                >
                  ⎘
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
