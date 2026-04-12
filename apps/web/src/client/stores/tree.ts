import type { TreeNode } from "@ironlore/core";
import { create } from "zustand";

interface TreeStore {
  nodes: TreeNode[];
  expandedPaths: Set<string>;
  loading: boolean;

  setNodes: (nodes: TreeNode[]) => void;
  toggleExpanded: (path: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useTreeStore = create<TreeStore>((set) => ({
  nodes: [],
  expandedPaths: new Set<string>(),
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
      return { expandedPaths: next };
    }),
  setLoading: (loading) => set({ loading }),
}));
