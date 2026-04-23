import { describe, expect, it } from "vitest";
import { BODY, buildHeadCloud, SOCKETS } from "./DottedHead.js";

/**
 * Pure-function tests for the head-cloud sampler. We don't exercise
 * the canvas/DOM path here — those are tested in manual browser walks
 * — but the geometry generator is deterministic and easy to assert on.
 */

describe("buildHeadCloud", () => {
  it("produces a non-trivial point count within expected bounds", () => {
    const flat = buildHeadCloud();
    const count = flat.length / 3;
    // Raw samples sum to ~1,645 before culling; we expect roughly
    //  60–85% to survive interior + socket pruning. Anything far
    //  outside that window means the geometry drifted meaningfully.
    const rawTotal = BODY.reduce((sum, e) => sum + e.count, 0);
    expect(count).toBeGreaterThan(rawTotal * 0.55);
    expect(count).toBeLessThan(rawTotal);
  });

  it("emits flat [x,y,z,...] triples with finite values only", () => {
    const flat = buildHeadCloud();
    expect(flat.length % 3).toBe(0);
    for (let i = 0; i < flat.length; i++) {
      expect(Number.isFinite(flat[i] as number)).toBe(true);
    }
  });

  it("removes dots that fall inside the eye sockets", () => {
    const flat = buildHeadCloud();
    for (let i = 0; i < flat.length; i += 3) {
      const x = flat[i] as number;
      const y = flat[i + 1] as number;
      const z = flat[i + 2] as number;
      for (const s of SOCKETS) {
        const dx = (x - s.cx) / s.rx;
        const dy = (y - s.cy) / s.ry;
        const dz = (z - s.cz) / s.rz;
        const inside = dx * dx + dy * dy + dz * dz < 1;
        expect(inside).toBe(false);
      }
    }
  });

  it("sits inside the head's expected bounding box", () => {
    const flat = buildHeadCloud();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < flat.length; i += 3) {
      const x = flat[i] as number;
      const y = flat[i + 1] as number;
      const z = flat[i + 2] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    // Cranium + ears stretch X to ~±0.55. Neck pulls Y to ~−1.2 and
    //  cranium reaches ~+0.7. Nose tip pokes Z forward to ~+0.67.
    expect(minX).toBeGreaterThan(-0.6);
    expect(maxX).toBeLessThan(0.6);
    expect(minY).toBeGreaterThan(-1.3);
    expect(maxY).toBeLessThan(0.75);
    expect(minZ).toBeGreaterThan(-0.6);
    expect(maxZ).toBeLessThan(0.75);
  });

  it("is deterministic across invocations (same shape every call)", () => {
    const a = buildHeadCloud();
    const b = buildHeadCloud();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });
});
