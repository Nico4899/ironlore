import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./app.js";

/**
 * App store behavior tests — focuses on tab management rules that
 * enforce UX invariants (10-tab cap, close-active-fallback).
 */

describe("useAppStore — tab management", () => {
  beforeEach(() => {
    // Reset to a clean state between tests.
    useAppStore.setState({ activePath: null, openPaths: [] });
  });

  it("opens a new file as a tab", () => {
    useAppStore.getState().setActivePath("a.md");
    expect(useAppStore.getState().openPaths).toEqual(["a.md"]);
    expect(useAppStore.getState().activePath).toBe("a.md");
  });

  it("reusing an already-open path does not duplicate", () => {
    useAppStore.getState().setActivePath("a.md");
    useAppStore.getState().setActivePath("a.md");
    expect(useAppStore.getState().openPaths).toEqual(["a.md"]);
  });

  it("activating another tab preserves the open set", () => {
    useAppStore.getState().setActivePath("a.md");
    useAppStore.getState().setActivePath("b.md");
    useAppStore.getState().setActivePath("a.md");
    expect(useAppStore.getState().openPaths).toEqual(["a.md", "b.md"]);
    expect(useAppStore.getState().activePath).toBe("a.md");
  });

  it("caps open tabs at 10 by closing the oldest", () => {
    const store = useAppStore.getState();
    for (let i = 0; i < 10; i++) store.setActivePath(`file-${i}.md`);
    expect(useAppStore.getState().openPaths).toHaveLength(10);
    expect(useAppStore.getState().openPaths[0]).toBe("file-0.md");

    // 11th tab — should evict file-0.md
    store.setActivePath("file-10.md");
    expect(useAppStore.getState().openPaths).toHaveLength(10);
    expect(useAppStore.getState().openPaths[0]).toBe("file-1.md");
    expect(useAppStore.getState().openPaths[9]).toBe("file-10.md");
  });

  it("closing the active tab falls back to the left neighbor", () => {
    const store = useAppStore.getState();
    store.setActivePath("a.md");
    store.setActivePath("b.md");
    store.setActivePath("c.md");
    store.closeTab("c.md");
    expect(useAppStore.getState().activePath).toBe("b.md");
  });

  it("closing the leftmost active tab falls back to the first remaining", () => {
    const store = useAppStore.getState();
    store.setActivePath("a.md");
    store.setActivePath("b.md");
    // Switch active to leftmost
    store.setActivePath("a.md");
    store.closeTab("a.md");
    expect(useAppStore.getState().activePath).toBe("b.md");
  });

  it("closing a non-active tab keeps the current active", () => {
    const store = useAppStore.getState();
    store.setActivePath("a.md");
    store.setActivePath("b.md");
    store.closeTab("a.md");
    expect(useAppStore.getState().activePath).toBe("b.md");
    expect(useAppStore.getState().openPaths).toEqual(["b.md"]);
  });

  it("closing the last tab leaves active null", () => {
    const store = useAppStore.getState();
    store.setActivePath("a.md");
    store.closeTab("a.md");
    expect(useAppStore.getState().activePath).toBeNull();
    expect(useAppStore.getState().openPaths).toEqual([]);
  });
});

describe("useAppStore — sidebar + theme", () => {
  beforeEach(() => {
    useAppStore.setState({ sidebarOpen: true, theme: "dark" });
  });

  it("toggles sidebar open/closed", () => {
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(false);
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);
  });

  it("toggles theme dark <-> light", () => {
    expect(useAppStore.getState().theme).toBe("dark");
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("light");
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("dark");
  });
});

describe("useAppStore — sidebar folder drill-down", () => {
  beforeEach(() => {
    useAppStore.setState({ sidebarFolder: "", sidebarTab: "files" });
  });

  it("sets sidebar folder path", () => {
    useAppStore.getState().setSidebarFolder("carousel");
    expect(useAppStore.getState().sidebarFolder).toBe("carousel");
  });

  it("switches sidebar tab", () => {
    useAppStore.getState().setSidebarTab("inbox");
    expect(useAppStore.getState().sidebarTab).toBe("inbox");
  });
});
