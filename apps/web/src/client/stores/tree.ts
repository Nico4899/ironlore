import type { PageType, TreeNode } from "@ironlore/core";
import { create } from "zustand";

const EXPANDED_PATHS_KEY = "ironlore:expandedPaths";

function loadExpandedPaths(): Set<string> {
  try {
    const stored = localStorage.getItem(EXPANDED_PATHS_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as string[];
      return new Set(arr);
    }
  } catch {
    // Ignore corrupt localStorage
  }
  return new Set<string>();
}

function saveExpandedPaths(paths: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_PATHS_KEY, JSON.stringify([...paths]));
  } catch {
    // localStorage full or unavailable
  }
}

interface TreeStore {
  nodes: TreeNode[];
  expandedPaths: Set<string>;
  loading: boolean;

  setNodes: (nodes: TreeNode[]) => void;
  toggleExpanded: (path: string) => void;
  setLoading: (loading: boolean) => void;

  // Incremental updates (from WebSocket events)
  insertNode: (node: TreeNode) => void;
  updateNode: (path: string, updates: Partial<TreeNode>) => void;
  deleteNode: (path: string) => void;
  moveNode: (
    oldPath: string,
    newPath: string,
    name: string,
    fileType: PageType | "directory",
  ) => void;
}

export const useTreeStore = create<TreeStore>((set) => ({
  nodes: [],
  expandedPaths: loadExpandedPaths(),
  loading: true,

  setNodes: (nodes) => set({ nodes, loading: false }),

  toggleExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expandedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      saveExpandedPaths(next);
      return { expandedPaths: next };
    }),

  setLoading: (loading) => set({ loading }),

  insertNode: (node) =>
    set((s) => {
      // Avoid duplicates
      if (s.nodes.some((n) => n.path === node.path)) return s;

      // Insert in sorted position (by path)
      const nodes = [...s.nodes];
      const idx = nodes.findIndex((n) => n.path > node.path);
      if (idx === -1) {
        nodes.push(node);
      } else {
        nodes.splice(idx, 0, node);
      }
      return { nodes };
    }),

  updateNode: (path, updates) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.path === path ? { ...n, ...updates } : n)),
    })),

  deleteNode: (path) =>
    set((s) => ({
      // Remove the node and any children (for directory deletion)
      nodes: s.nodes.filter(
        (n) => n.path !== path && !n.path.startsWith(`${path}/`),
      ),
    })),

  moveNode: (oldPath, newPath, name, fileType) =>
    set((s) => {
      // Remove old node
      const nodes = s.nodes.filter(
        (n) => n.path !== oldPath && !n.path.startsWith(`${oldPath}/`),
      );
      // Insert new node in sorted position
      const newNode: TreeNode = {
        id: newPath,
        name,
        path: newPath,
        type: fileType,
      };
      const idx = nodes.findIndex((n) => n.path > newPath);
      if (idx === -1) {
        nodes.push(newNode);
      } else {
        nodes.splice(idx, 0, newNode);
      }
      return { nodes };
    }),
}));
