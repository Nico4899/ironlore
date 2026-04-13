import type { WsEvent } from "@ironlore/core";
import { useEffect } from "react";
import { fetchTree } from "../lib/api.js";
import { wsClient } from "../lib/ws.js";
import { useAppStore } from "../stores/app.js";
import { useTreeStore } from "../stores/tree.js";

/**
 * React hook that manages the WebSocket lifecycle.
 *
 * - Connects on mount, disconnects on unmount
 * - Updates `useAppStore.wsConnected` on open/close
 * - Dispatches `tree:*` events to `useTreeStore`
 * - On sequence gap: triggers full tree refresh
 */
export function useWebSocket(): void {
  useEffect(() => {
    wsClient.setConnectionChangeHandler((connected) => {
      useAppStore.getState().setWsConnected(connected);
    });

    wsClient.setGapHandler(() => {
      // Sequence gap detected — refresh the full tree
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
          // Network error — tree will be stale until next successful refresh
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
      // File content changed — no tree structure change needed,
      // but if the currently active file was updated externally,
      // the editor should know. For now, just update the node timestamp.
      break;

    case "tree:delete":
      tree.deleteNode(event.path);
      break;

    case "tree:move":
      tree.moveNode(event.oldPath, event.newPath, event.name, event.fileType);
      break;
  }
}
