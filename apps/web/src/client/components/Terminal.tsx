import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { AlertTriangle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/app.js";

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [height, setHeight] = useState(256);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  // ─── Resize handle ─────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [height]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    // Drag upward = increase height
    const delta = startY.current - e.clientY;
    setHeight(Math.max(120, Math.min(600, startH.current + delta)));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    fitRef.current?.fit();
  }, []);

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
      setDisconnected(false);
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

    ws.onerror = () => {
      setDisconnected(true);
    };

    ws.onclose = () => {
      setDisconnected(true);
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
    <div className="flex flex-col border-t border-border bg-ironlore-slate" style={{ height }}>
      {/* Resize handle */}
      <div
        className="h-1 cursor-row-resize bg-transparent hover:bg-ironlore-blue/30 active:bg-ironlore-blue/50"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
      />
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
      <div className="relative flex-1 overflow-hidden px-2 py-1">
        <div ref={containerRef} className="h-full w-full" />
        {disconnected && (
          <div className="absolute inset-0 flex items-center justify-center bg-ironlore-slate/80">
            <div className="flex flex-col items-center gap-2 text-sm">
              <AlertTriangle className="h-5 w-5 text-signal-amber" />
              <span className="text-primary">Terminal session ended</span>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1 text-xs text-secondary hover:bg-ironlore-slate-hover hover:text-primary"
                onClick={() => {
                  useAppStore.getState().toggleTerminal();
                  // Re-open triggers a fresh useEffect with new WS
                  setTimeout(() => useAppStore.getState().toggleTerminal(), 50);
                }}
              >
                Reconnect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
