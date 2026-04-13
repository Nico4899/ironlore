import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface SourceCodeViewerProps {
  content: string;
  path: string;
}

/** Map file extension → CodeMirror language support. */
function getLanguageExtension(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "md":
      return markdown();
    default:
      return null;
  }
}

function getLanguageLabel(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const labels: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TSX",
    js: "JavaScript",
    jsx: "JSX",
    py: "Python",
    go: "Go",
    rs: "Rust",
    rb: "Ruby",
    java: "Java",
    kt: "Kotlin",
    swift: "Swift",
    c: "C",
    cpp: "C++",
    h: "C Header",
    hpp: "C++ Header",
    cs: "C#",
    php: "PHP",
    sh: "Shell",
    bash: "Bash",
    zsh: "Zsh",
    fish: "Fish",
    lua: "Lua",
    r: "R",
    sql: "SQL",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    json: "JSON",
    xml: "XML",
    html: "HTML",
    css: "CSS",
    scss: "SCSS",
    md: "Markdown",
  };
  return labels[ext] ?? ext.toUpperCase();
}

export function SourceCodeViewer({ content, path }: SourceCodeViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; content changes handled by separate effect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const extensions = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];

    const lang = getLanguageExtension(path);
    if (lang) extensions.push(lang);

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Sync content changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc === content) return;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
  }, [content]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <span className="text-xs text-secondary">{getLanguageLabel(path)}</span>
        <div className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-secondary hover:bg-ironlore-slate-hover"
          onClick={handleCopy}
          aria-label="Copy file content"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* Editor */}
      <div ref={containerRef} className="flex-1 overflow-y-auto" />
    </div>
  );
}
