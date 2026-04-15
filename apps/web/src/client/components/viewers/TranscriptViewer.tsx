import { useMemo } from "react";

/**
 * Parse .vtt / .srt cues into `[timestamp, text]` rows.
 *
 * Both formats are line-oriented: a numeric or blank id line, a
 * `start --> end` timing line, then one or more text lines, blank
 * separator. We keep the start timestamp and concatenate body lines.
 */
interface Cue {
  time: string;
  text: string;
}

const TIMING_RE = /^(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*/;

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
    if (text) cues.push({ time, text });
  }
  return cues;
}

export function TranscriptViewer({ content }: { content: string }) {
  const cues = useMemo(() => parseCues(content), [content]);

  if (cues.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-secondary">No cues found</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Transcript ({cues.length} cues)</caption>
        <tbody>
          {cues.map((cue, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cues render-only, never reordered
            <tr key={`${cue.time}-${i}`} className="border-b border-border align-top">
              <td className="w-32 py-1 pr-4 font-mono text-xs text-secondary">{cue.time}</td>
              <td className="py-1 text-primary">{cue.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
