// Regression (2026-11-19, owner: the 3D truck "still isn't showing on
// the map"). Two MapLibre 5 rules the layer must keep:
// 1. draw with defaultProjectionData.mainMatrix (0..1 Mercator world) —
//    modelViewProjectionMatrix is pixel-world and puts the truck off screen;
// 2. renderer.resetState() before every draw (shared GL context).
// And: repaint only while gliding — a parked truck costs no frames.
import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const projections: number[][] = [];
vi.mock("three", async (importOriginal) => {
  const real = await importOriginal<typeof import("three")>();
  class FakeRenderer {
    autoClear = true;
    getSize(v: { x: number; y: number }) { v.x = 400; v.y = 600; return v; }
    setSize() {}
    resetState() { calls.push("resetState"); }
    render(_scene: unknown, camera: { projectionMatrix: { elements: number[] } }) {
      calls.push("render");
      projections.push([...camera.projectionMatrix.elements]);
    }
    dispose() {}
  }
  return { ...real, WebGLRenderer: FakeRenderer };
});

import { createTruckMapLayer } from "@/lib/truck-map-layer";

function fakeMap() {
  return {
    getCanvas: () => ({ clientWidth: 400, clientHeight: 600 }),
    triggerRepaint: vi.fn(),
  };
}

const MAIN = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 2 : 0));
const PIXEL_MVP = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1e9 : 0));
const options = { modelViewProjectionMatrix: PIXEL_MVP, defaultProjectionData: { mainMatrix: MAIN } };

describe("truck map layer render", () => {
  it("resets three's GL state before drawing, uses mainMatrix, and stops repainting once the truck arrives", () => {
    let state = { position: { lat: 35, lng: -80 }, headingDeg: 90 };
    const layer = createTruckMapLayer(
      () => state,
      (p) => ({ x: (p.lng + 180) / 360, y: 0.4, z: 0, metersPerUnit: 1e-7 }),
    );
    const map = fakeMap();
    layer.onAdd!(map as never, {} as WebGLRenderingContext);
    layer.render!({} as WebGLRenderingContext, options as never);
    expect(calls).toEqual(["resetState", "render"]);
    // the projection was built from mainMatrix (values ~2), not the pixel MVP (~1e9)
    expect(Math.max(...projections[0]!.map(Math.abs))).toBeLessThan(1e3);
    // parked on the first fix: no extra frames
    expect(map.triggerRepaint).not.toHaveBeenCalled();
    // a new fix starts a glide: the layer asks for the next frame
    state = { position: { lat: 35, lng: -79.999 }, headingDeg: 90 };
    layer.render!({} as WebGLRenderingContext, options as never);
    expect(map.triggerRepaint).toHaveBeenCalled();
  });
});
