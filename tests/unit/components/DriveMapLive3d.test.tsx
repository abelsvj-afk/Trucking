// @vitest-environment jsdom
//
// Harness for the drive-map live-3D fix (owner 2026-11-17): the map
// the owner sees WHILE DRIVING — Home mini map AND Drive surface —
// must be tilted 3D, heading-up, truck at the bottom, street-level
// follow zoom, truck ON the route, and the truck itself a REAL 3D
// model. MapLibre is faked (a real map needs a browser + tiles);
// the layer, the camera calls, and the model's projection matrix
// are all asserted against the fake. The matrix math itself is
// unit-tested in truck-map-layer.test.ts; this proves the wiring.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import * as THREE from "three";
import type { CustomRenderMethodInput } from "maplibre-gl";

// --- Fake MapLibre + fake three.js renderer (no GL context in jsdom) ---
// Shared through vi.hoisted: mock factories run before the module body,
// so the fakes they close over must be built here.
const fakes = vi.hoisted(() => {
  interface FakeLayer {
    id: string;
    type: string;
    renderingMode?: string;
    onAdd?: (map: unknown, gl: unknown) => void;
    onRemove?: (map: unknown, gl: unknown) => void;
    render: (gl: unknown, options: unknown) => void;
  }
  const state = {
    easeToCalls: [] as Array<Record<string, unknown>>,
    fitBoundsCalls: [] as unknown[],
    triggerRepaintCalls: [] as number[],
    addedLayers: [] as FakeLayer[],
    removedLayers: [] as string[],
    markerInstances: [] as Array<{ removed: boolean }>,
    mapConstructorOpts: null as Record<string, unknown> | null,
    loadHandler: null as (() => void) | null,
    rendererRenderCalls: [] as Array<{ scene: object; camera: object }>,
  };
  class FakeMarker {
    removed = false;
    constructor() {
      state.markerInstances.push(this);
    }
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.removed = true;
      return this;
    }
  }
  class FakeBounds {
    extend() {
      return this;
    }
  }
  class FakeMap {
    constructor(opts: Record<string, unknown>) {
      state.mapConstructorOpts = opts;
    }
    on(event: string, cb: () => void) {
      if (event === "load") state.loadHandler = cb;
    }
    isStyleLoaded() {
      return true;
    }
    getCanvas() {
      return { clientWidth: 500, clientHeight: 400 };
    }
    getSource() {
      return { setData: () => {} };
    }
    addSource() {}
    addLayer(layer: FakeLayer) {
      state.addedLayers.push(layer);
      layer.onAdd?.(this, {});
    }
    getLayer(id: string) {
      return state.addedLayers.find((l) => l.id === id);
    }
    removeLayer(id: string) {
      const layer = state.addedLayers.find((l) => l.id === id);
      layer?.onRemove?.(this, {});
      const idx = state.addedLayers.findIndex((l) => l.id === id);
      if (idx >= 0) state.addedLayers.splice(idx, 1);
      state.removedLayers.push(id);
    }
    easeTo(opts: Record<string, unknown>) {
      state.easeToCalls.push(opts);
    }
    fitBounds(...args: unknown[]) {
      state.fitBoundsCalls.push(args);
    }
    triggerRepaint() {
      state.triggerRepaintCalls.push(1);
    }
    remove() {}
  }
  class FakeRenderer {
    autoClear = true;
    constructor(_opts: unknown) {}
    getSize(target: { set: (x: number, y: number) => void }) {
      return target.set(0, 0);
    }
    setSize() {}
    render(scene: object, camera: object) {
      state.rendererRenderCalls.push({ scene, camera });
    }
    dispose() {}
  }
  return { state, FakeMap, FakeMarker, FakeBounds, FakeRenderer };
});

const {
  easeToCalls,
  fitBoundsCalls,
  triggerRepaintCalls,
  addedLayers,
  removedLayers,
  markerInstances,
  rendererRenderCalls,
} = fakes.state;

vi.mock("maplibre-gl", () => {
  // The real maplibre-gl module cannot load in jsdom (it calls
  // URL.createObjectURL at import time), so the mock carries the
  // one piece of pure math the layer needs — the Mercator
  // projection, straight from maplibre's own formulas — inline.
  const MercatorCoordinate = {
    fromLngLat: (lngLat: [number, number] | { lng: number; lat: number }, altitude = 0) => {
      const lng = Array.isArray(lngLat) ? lngLat[0] : lngLat.lng;
      const lat = Array.isArray(lngLat) ? lngLat[1] : lngLat.lat;
      const sin = Math.sin((lat * Math.PI) / 180);
      return {
        x: (lng + 180) / 360,
        y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
        z: altitude,
        meterInMercatorCoordinateUnits: () => 1 / (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)),
      };
    },
  };
  return {
    default: {
      Map: fakes.FakeMap,
      Marker: fakes.FakeMarker,
      LngLatBounds: fakes.FakeBounds,
      MercatorCoordinate,
    },
  };
});

vi.mock("three", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");
  return { ...actual, WebGLRenderer: fakes.FakeRenderer };
});

vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

import DriveMap from "@/components/DriveMap";

const GEOMETRY = [
  { lat: 32.0, lng: -91.2 },
  { lat: 32.1, lng: -91.1 },
  { lat: 32.2, lng: -91.0 },
];
const IDENTITY_MVP = new THREE.Matrix4().identity().toArray();

function resetFakes() {
  easeToCalls.length = 0;
  fitBoundsCalls.length = 0;
  triggerRepaintCalls.length = 0;
  addedLayers.length = 0;
  removedLayers.length = 0;
  markerInstances.length = 0;
  fakes.state.mapConstructorOpts = null;
  fakes.state.loadHandler = null;
  rendererRenderCalls.length = 0;
}

afterEach(() => {
  cleanup();
  resetFakes();
  vi.clearAllMocks();
});

async function mountAndLoad(ui: ReactElement) {
  const rendered = render(ui);
  await waitFor(() => expect(fakes.state.mapConstructorOpts).not.toBeNull());
  fakes.state.loadHandler?.();
  return rendered;
}

// jsdom does no layout, so the map container reports height 0 —
// give it a real height so the truck's down-screen offset is measurable.
function setMapHeight(rendered: ReturnType<typeof render>, heightPx: number) {
  const el = rendered.container.firstChild as HTMLElement;
  Object.defineProperty(el, "clientHeight", { value: heightPx, configurable: true });
}

async function driveOneFix(rendered: ReturnType<typeof render>, ui: ReactElement) {
  rendered.rerender(ui);
  await waitFor(() => expect(triggerRepaintCalls.length).toBeGreaterThan(0));
}

function homeMap(position: { lat: number; lng: number }, headingDeg = 90) {
  return (
    <DriveMap
      geometry={GEOMETRY}
      deadheadGeometry={[]}
      stops={[]}
      stopStatus={[]}
      position={position}
      headingDeg={headingDeg}
      positionQuality="good"
      follow
      onUserPan={() => {}}
      night={false}
      height="46vh"
      view3d
      headingUp
      followZoom={15.5}
      interactive={false}
      frameRoute={false}
    />
  );
}

function driveMap(position: { lat: number; lng: number }, headingDeg = 180) {
  return (
    <DriveMap
      geometry={GEOMETRY}
      deadheadGeometry={[]}
      stops={[]}
      stopStatus={[]}
      position={position}
      headingDeg={headingDeg}
      positionQuality="good"
      follow
      onUserPan={() => {}}
      night={false}
      height="46vh"
      view3d
      headingUp
    />
  );
}

describe("DriveMap live 3D (Home + Drive surfaces)", () => {
  it("Home-style: tilted 3D, follow zoom, heading bearing, the real model — never a whole-route frame", async () => {
    const rendered = await mountAndLoad(homeMap({ lat: 32.05, lng: -91.15 }));
    expect(fakes.state.mapConstructorOpts?.pitch).toBe(60);
    setMapHeight(rendered, 400);
    await driveOneFix(rendered, homeMap({ lat: 32.06, lng: -91.14 }));

    // The 3D truck layer is on the map; no flat HTML marker exists.
    const layer = addedLayers.find((l) => l.id === "drive-truck-3d");
    expect(layer).toBeDefined();
    expect(layer?.type).toBe("custom");
    expect(layer?.renderingMode).toBe("3d");
    expect(markerInstances).toHaveLength(0);
    // Follow camera: street-level zoom + heading bearing, truck pushed down-screen.
    const lastEase = easeToCalls[easeToCalls.length - 1]!;
    expect(lastEase.zoom).toBe(15.5);
    expect(lastEase.bearing).toBe(90);
    expect(lastEase.pitch).toBe(60);
    expect((lastEase.offset as [number, number])[1]).toBe(88); // 22% of 400
    // No whole-route framing while following.
    expect(fitBoundsCalls).toHaveLength(0);

    // The model itself: render the layer and read where the truck lands.
    layer!.render(
      {} as never,
      { modelViewProjectionMatrix: IDENTITY_MVP } as unknown as CustomRenderMethodInput,
    );
    expect(rendererRenderCalls).toHaveLength(1);
    const camera = rendererRenderCalls[0]!.camera as THREE.Camera;
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(camera.projectionMatrix);
    const nose = new THREE.Vector3(0, 0, 1).applyMatrix4(camera.projectionMatrix);
    const dir = nose.clone().sub(origin).normalize();
    // Heading 90 = east.
    expect(dir.x).toBeCloseTo(1, 4);
    expect(dir.y).toBeCloseTo(0, 4);
    expect(dir.z).toBeCloseTo(0, 4);
    // The model sits at the truck's real Mercator position
    // (lng -91.14 -> x 0.2468; lat 32.06 -> y ~0.406), not at the map's centre.
    expect(origin.x).toBeCloseTo(0.2468, 3);
    expect(origin.y).toBeCloseTo(0.406, 2);
  });

  it("Drive-style: same 3D + follow behaviour with the default follow zoom", async () => {
    const rendered = await mountAndLoad(driveMap({ lat: 32.05, lng: -91.15 }));
    expect(fakes.state.mapConstructorOpts?.pitch).toBe(60);
    await driveOneFix(rendered, driveMap({ lat: 32.06, lng: -91.14 }));
    expect(addedLayers.some((l) => l.id === "drive-truck-3d")).toBe(true);
    const lastEase = easeToCalls[easeToCalls.length - 1]!;
    expect(lastEase.zoom).toBe(15); // the 3D follow default
    expect(lastEase.bearing).toBe(180);
    expect(fitBoundsCalls).toHaveLength(0);
  });

  it("flat mode: no model layer, the honest flat icon, and the flat map STILL zooms in + rotates while following", async () => {
    const flat = (position: { lat: number; lng: number }) => (
      <DriveMap
        geometry={GEOMETRY}
        deadheadGeometry={[]}
        stops={[]}
        stopStatus={[]}
        position={position}
        headingDeg={90}
        positionQuality="good"
        follow
        onUserPan={() => {}}
        night={false}
        height="46vh"
        view3d={false}
        headingUp
        followZoom={15.5}
        interactive={false}
        frameRoute={false}
      />
    );
    const rendered = await mountAndLoad(flat({ lat: 32.05, lng: -91.15 }));
    expect(fakes.state.mapConstructorOpts?.pitch).toBe(0);
    rendered.rerender(flat({ lat: 32.06, lng: -91.14 }));
    await waitFor(() => expect(markerInstances.length).toBeGreaterThan(0));
    expect(addedLayers.some((l) => l.id === "drive-truck-3d")).toBe(false);
    const lastEase = easeToCalls[easeToCalls.length - 1]!;
    expect(lastEase.zoom).toBe(15.5);
    expect(lastEase.bearing).toBe(90);
    expect(lastEase.pitch).toBe(0);
  });

  it("toggling 3D off removes the model layer", async () => {
    const rendered = await mountAndLoad(homeMap({ lat: 32.05, lng: -91.15 }));
    await driveOneFix(rendered, homeMap({ lat: 32.06, lng: -91.14 }));
    expect(addedLayers.some((l) => l.id === "drive-truck-3d")).toBe(true);
    const flat = (
      <DriveMap
        geometry={GEOMETRY}
        deadheadGeometry={[]}
        stops={[]}
        stopStatus={[]}
        position={{ lat: 32.06, lng: -91.14 }}
        headingDeg={90}
        positionQuality="good"
        follow
        onUserPan={() => {}}
        night={false}
        height="46vh"
        view3d={false}
        headingUp
        followZoom={15.5}
      />
    );
    rendered.rerender(flat);
    await waitFor(() => expect(removedLayers).toContain("drive-truck-3d"));
    expect(addedLayers.some((l) => l.id === "drive-truck-3d")).toBe(false);
  });
});
