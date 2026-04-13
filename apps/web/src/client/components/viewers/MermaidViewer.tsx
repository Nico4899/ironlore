import { Code, Eye } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface MermaidViewerProps {
  content: string;
}

export function MermaidViewer({ content }: MermaidViewerProps) {
  const [mode, setMode] = useState<"diagram" | "source">("diagram");
  const diagramRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "diagram" || !diagramRef.current) return;

    let cancelled = false;
    const container = diagramRef.current;

    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });

        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, content);

        if (cancelled) return;

        // Parse the SVG and inject via DOM (avoids dangerouslySetInnerHTML)
        const parser = new DOMParser();
        const doc = parser.parseFromString(svg, "image/svg+xml");
        const svgEl = doc.documentElement;

        container.replaceChildren(svgEl);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render diagram");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [content, mode]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === "diagram" ? "source" : "diagram"));
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <div className="flex rounded border border-border text-xs">
          <button
            type="button"
            className={`flex items-center gap-1 px-3 py-1 ${mode === "diagram" ? "bg-ironlore-slate-hover font-medium" : "hover:bg-ironlore-slate-hover"}`}
            onClick={() => setMode("diagram")}
            aria-pressed={mode === "diagram"}
          >
            <Eye className="h-3.5 w-3.5" />
            Diagram
          </button>
          <button
            type="button"
            className={`flex items-center gap-1 border-l border-border px-3 py-1 ${mode === "source" ? "bg-ironlore-slate-hover font-medium" : "hover:bg-ironlore-slate-hover"}`}
            onClick={toggleMode}
            aria-pressed={mode === "source"}
          >
            <Code className="h-3.5 w-3.5" />
            Source
          </button>
        </div>
      </div>

      {/* Content */}
      {mode === "diagram" ? (
        <div className="flex flex-1 items-center justify-center overflow-auto p-8">
          {error ? (
            <div className="rounded border border-signal-red bg-ironlore-slate p-4 text-sm text-signal-red">
              {error}
            </div>
          ) : (
            <div ref={diagramRef} className="max-w-full" />
          )}
        </div>
      ) : (
        <pre className="flex-1 overflow-auto p-4 font-mono text-sm">{content}</pre>
      )}
    </div>
  );
}
