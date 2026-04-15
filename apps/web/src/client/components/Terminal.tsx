import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAppStore } from "../stores/app.js";

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue("--color-ironlore-slate").trim();
    const fg = styles.getPropertyValue("--color-primary").trim();
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      theme: {
        background: bg,
        foreground: fg,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Connect to terminal WebSocket
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/terminal`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send initial resize
      ws.send(
        JSON.stringify({
          type: "terminal:resize",
          cols: term.cols,
          rows: term.rows,
        }),
      );
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        term.write(event.data);
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buf) => {
          term.write(new Uint8Array(buf));
        });
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "terminal:resize", cols, rows }));
      }
    });

    const handleResize = () => {
      fit.fit();
    };
    window.addEventListener("resize", handleResize);

    // Observe container size changes
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    return () => {
      window.removeEventListener("resize", handleResize);
      ro.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, []);

  return (
    <div className="flex h-64 flex-col border-t border-border bg-ironlore-slate">
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <span className="text-xs text-secondary">Terminal</span>
        <button
          type="button"
          className="rounded p-1 text-secondary hover:bg-ironlore-slate-hover"
          onClick={() => useAppStore.getState().toggleTerminal()}
          aria-label="Close terminal"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden px-2 py-1" />
    </div>
  );
}
