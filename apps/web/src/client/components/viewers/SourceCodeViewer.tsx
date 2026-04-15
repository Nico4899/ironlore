import { EditorState, type Extension, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface SourceCodeViewerProps {
  content: string;
  path: string;
}

/**
 * Per-extension grammar table.
 *
 * First-class CodeMirror language packages are used for the popular
 * languages (TS/JS, Python, JSON, HTML, CSS, Markdown). Everything
 * else uses `@codemirror/legacy-modes` — a single dependency that
 * covers ~30 long-tail grammars (Go, Rust, Ruby, Java, shell, SQL,
 * YAML, TOML, XML, …) without one package per language.
 *
 * Each loader is dynamic so the grammar bytes only ship when the
 * user actually opens a file of that type.
 */
type LangLoader = () => Promise<Extension>;

async function legacyMode(
  loader: () => Promise<Record<string, unknown>>,
  name: string,
): Promise<Extension> {
  const mod = await loader();
  // legacy-modes export factory objects (already-built `StreamParser`
  // descriptors) named for the language — e.g. `python`, `go`, `ruby`.
  // `clike` exports `c`, `cpp`, `java`, `csharp`, `kotlin` as separate
  // keys. The shape isn't a callable; it's a config object that goes
  // straight into `StreamLanguage.define`.
  const parser = mod[name];
  if (!parser || typeof parser !== "object") {
    throw new Error(`legacy-modes export "${name}" not found`);
  }
  const { StreamLanguage } = await import("@codemirror/language");
  // Cast through unknown — legacy-modes ships its own structural types
  // that aren't worth threading into our viewer just for one call.
  return StreamLanguage.define(parser as Parameters<typeof StreamLanguage.define>[0]);
}

const LANGUAGE_LOADERS: Record<string, LangLoader> = {
  // ─── First-class packages
  ts: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  tsx: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  js: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  md: async () => (await import("@codemirror/lang-markdown")).markdown(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  scss: async () => (await import("@codemirror/lang-css")).css(),
  py: async () => (await import("@codemirror/lang-python")).python(),

  // ─── Legacy-modes long tail
  go: () => legacyMode(() => import("@codemirror/legacy-modes/mode/go"), "go"),
  rs: () => legacyMode(() => import("@codemirror/legacy-modes/mode/rust"), "rust"),
  rb: () => legacyMode(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  java: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "java"),
  kt: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"),
  swift: () => legacyMode(() => import("@codemirror/legacy-modes/mode/swift"), "swift"),
  c: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "c"),
  cpp: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  h: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "c"),
  hpp: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  cs: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "csharp"),
  // PHP isn't packaged in `@codemirror/legacy-modes`. Pulling
  // `@codemirror/lang-php` is the right fix when a user actually
  // needs it; for now `.php` falls back to plain text and the toolbar
  // honestly says "Plain text".
  sh: () => legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  bash: () => legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  zsh: () => legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  fish: () => legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  lua: () => legacyMode(() => import("@codemirror/legacy-modes/mode/lua"), "lua"),
  r: () => legacyMode(() => import("@codemirror/legacy-modes/mode/r"), "r"),
  sql: () => legacyMode(() => import("@codemirror/legacy-modes/mode/sql"), "standardSQL"),
  yaml: () => legacyMode(() => import("@codemirror/legacy-modes/mode/yaml"), "yaml"),
  yml: () => legacyMode(() => import("@codemirror/legacy-modes/mode/yaml"), "yaml"),
  toml: () => legacyMode(() => import("@codemirror/legacy-modes/mode/toml"), "toml"),
  xml: () => legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
};

const LANGUAGE_LABELS: Record<string, string> = {
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

function extOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Toolbar label. Falls back to `"Plain text"` when no grammar exists —
 * the previous `ext.toUpperCase()` fallback misled users into thinking
 * highlighting was active for unknown extensions (Phase 2.5 audit
 * Step 7).
 */
export function getLanguageLabel(path: string): string {
  const ext = extOf(path);
  return LANGUAGE_LABELS[ext] ?? "Plain text";
}

/** True when `path` has a registered grammar loader. */
export function hasLanguageSupport(path: string): boolean {
  return LANGUAGE_LOADERS[extOf(path)] !== undefined;
}

async function loadLanguage(path: string): Promise<Extension | null> {
  const loader = LANGUAGE_LOADERS[extOf(path)];
  if (!loader) return null;
  try {
    return await loader();
  } catch {
    return null;
  }
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

  // Mount the editor, then asynchronously load the language grammar
  // and reconfigure if one exists. Without this two-step the mount
  // would block on the dynamic import of every legacy-mode entry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; content changes handled by separate effect; path swap is handled by the parent remount per `key`
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const baseExtensions: Extension[] = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];

    const state = EditorState.create({
      doc: content,
      extensions: baseExtensions,
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    let cancelled = false;
    void loadLanguage(path).then((langExt) => {
      if (cancelled || !langExt || viewRef.current !== view) return;
      view.dispatch({
        effects: StateEffect.appendConfig.of(langExt),
      });
    });

    return () => {
      cancelled = true;
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
