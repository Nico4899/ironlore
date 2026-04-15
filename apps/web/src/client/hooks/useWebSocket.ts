import type { WsEvent } from "@ironlore/core";
import { useEffect } from "react";
import { fetchTree } from "../lib/api.js";
import { wsClient } from "../lib/ws.js";
import { useAppStore } from "../stores/app.js";
import { useTreeStore } from "../stores/tree.js";

/**
 * React hook that manages the WebSocket lifecycle.
 *
 * - Connects on mount, disconnects on unmount.
 * - Updates `useAppStore.wsConnected` on open/close.
 * - Dispatches `tree:*` events to `useTreeStore`.
 * - On resync (server buffer overflow / server restart / unexpected seq
 *   gap): triggers a full tree refresh. Ordinary reconnects replay
 *   buffered events instead, so no brute-force refetch is needed —
 *   this path only runs when the server explicitly said state is lost.
 */
export function useWebSocket(): void {
  useEffect(() => {
    wsClient.setConnectionChangeHandler((connected) => {
      useAppStore.getState().setWsConnected(connected);
    });

    wsClient.setResyncHandler(() => {
      // Cold refresh — the replay buffer couldn't cover our gap, so
      // the only safe move is to rehydrate tree state from the API.
      fetchTree()
        .then(({ pages }) => {
          useTreeStore.getState().setNodes(
            pages.map((p) => ({
              id: p.path,
              name: p.name,
              path: p.path,
              type: p.type,
            })),
          );
        })
        .catch(() => {
          // Network error — tree stays stale until the next successful
          // refresh. No user-visible action here; the offline banner
          // will surface if the server is actually unreachable.
        });
    });

    wsClient.onEvent(handleWsEvent);
    wsClient.connect();

    return () => {
      wsClient.disconnect();
    };
  }, []);
}

function handleWsEvent(event: WsEvent): void {
  const tree = useTreeStore.getState();

  switch (event.type) {
    case "tree:add":
      tree.insertNode({
        id: event.path,
        name: event.name,
        path: event.path,
        type: event.fileType,
      });
      break;

    case "tree:update":
      // File content changed — no tree structure change needed.
      break;

    case "tree:delete":
      tree.deleteNode(event.path);
      break;

    case "tree:move":
      tree.moveNode(event.oldPath, event.newPath, event.name, event.fileType);
      break;
  }
}
