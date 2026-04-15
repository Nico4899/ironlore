import { describe, expect, it } from "vitest";
import { disambiguateTabLabels } from "./TabBar.js";

describe("disambiguateTabLabels", () => {
  it("returns bare basenames when there are no collisions", () => {
    const labels = disambiguateTabLabels(["a/foo.md", "b/bar.md"]);
    expect(labels.get("a/foo.md")).toBe("foo.md");
    expect(labels.get("b/bar.md")).toBe("bar.md");
  });

  it("expands one segment for a basename collision", () => {
    const labels = disambiguateTabLabels([
      ".agents/editor/persona.md",
      ".agents/general/persona.md",
    ]);
    expect(labels.get(".agents/editor/persona.md")).toBe("editor / persona.md");
    expect(labels.get(".agents/general/persona.md")).toBe("general / persona.md");
  });

  it("keeps non-colliding tabs at depth 1 even when others expand", () => {
    const labels = disambiguateTabLabels([
      ".agents/editor/persona.md",
      ".agents/general/persona.md",
      "notes/random.md",
    ]);
    expect(labels.get("notes/random.md")).toBe("random.md");
    expect(labels.get(".agents/editor/persona.md")).toBe("editor / persona.md");
  });

  it("expands further when one-segment expansion is still ambiguous", () => {
    const labels = disambiguateTabLabels([
      "team-a/agents/editor/persona.md",
      "team-b/agents/editor/persona.md",
    ]);
    expect(labels.get("team-a/agents/editor/persona.md")).toBe(
      "team-a / agents / editor / persona.md",
    );
    expect(labels.get("team-b/agents/editor/persona.md")).toBe(
      "team-b / agents / editor / persona.md",
    );
  });

  it("handles single-segment paths without crashing", () => {
    const labels = disambiguateTabLabels(["readme.md"]);
    expect(labels.get("readme.md")).toBe("readme.md");
  });

  it("returns an empty map for an empty input", () => {
    expect(disambiguateTabLabels([])).toEqual(new Map());
  });
});
