// The real 3D truck on the map (owner 2026-11-17): a MapLibre custom
// WebGL layer (`type: "custom"`, `renderingMode: "3d"`) that draws the
// procedural semi from truck-model.ts through three.js, in the map's
// own GL context. The model sits at the truck's real position and
// turns to its real heading; the map's tilt gives it the angle, the
// shading gives it the depth.
//
// Two things this layer deliberately does NOT do:
// - It never calls `map.triggerRepaint()` from inside `render` —
//   that would loop the renderer forever and drain the battery.
//   The DriveMap position effect repaints when a new fix arrives.
// - It never invents a position: with no fix, nothing is drawn.
//
// Scale, stated plainly: a true-scale rig is ~5 px at follow zoom
// 15, so the model is drawn 10x true size (like every GPS vehicle
// marker — position and heading are true, size is exaggerated so
// the truck can be seen). A detailed GLB can replace the procedural
// model later through the same layer.

import * as THREE from "three";
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import { buildTruckModel } from "./truck-model";
import type { LatLng } from "./smart-path";

export const TRUCK_MAP_LAYER_ID = "drive-truck-3d";
/** Drawn size vs true size (see the note above). */
export const TRUCK_MODEL_EXAGGERATION = 10;

/** A position in MapLibre's Mercator world (from MercatorCoordinate.fromLngLat). */
export interface TruckMercatorPosition {
  x: number;
  y: number;
  z: number;
  /** Mercator units per meter at this latitude. */
  metersPerUnit: number;
}

export interface TruckLayerState {
  position: LatLng;
  headingDeg: number | null;
}

/**
 * The full projection for the truck model: the map's
 * model-view-projection matrix, then into Mercator world space at the
 * truck's position, then the heading rotation around the vertical,
 * then the model's own up (three.js Y-up to map Z-up). Pure — the
 * heading math is unit-tested without any GL context.
 *
 * Model frame: +Y up, +Z forward. The MapLibre example chain
 * (translate · scale with a flipped Y · Rx(90°)) maps model +Z to
 * SOUTH, so the heading rotation is 180° − heading: 180° turns the
 * nose to north, and the heading then turns it clockwise from
 * there (0 = north, 90 = east).
 */
export function computeTruckMatrix(
  modelViewProjectionMatrix: ArrayLike<number>,
  merc: TruckMercatorPosition,
  headingDeg: number,
  exaggeration: number = TRUCK_MODEL_EXAGGERATION,
): THREE.Matrix4 {
  const scale = merc.metersPerUnit * exaggeration;
  const m = new THREE.Matrix4().fromArray(modelViewProjectionMatrix);
  const l = new THREE.Matrix4()
    .makeTranslation(merc.x, merc.y, merc.z)
    .scale(new THREE.Vector3(scale, -scale, scale));
  const rotZ = new THREE.Matrix4().makeRotationAxis(
    new THREE.Vector3(0, 0, 1),
    THREE.MathUtils.degToRad(180 - headingDeg),
  );
  const rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  return m.multiply(l).multiply(rotZ).multiply(rotX);
}

/**
 * The custom layer. `getState` reads the latest fix (DriveMap's refs,
 * so the layer always draws the newest position without being
 * re-added); `project` turns a position into Mercator world
 * coordinates (the caller owns the maplibre-gl import).
 */
export function createTruckMapLayer(
  getState: () => TruckLayerState | null,
  project: (position: LatLng) => TruckMercatorPosition,
): CustomLayerInterface {
  let map: MapLibreMap | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.Camera | null = null;
  const size = new THREE.Vector2();

  return {
    id: TRUCK_MAP_LAYER_ID,
    type: "custom",
    renderingMode: "3d",
    onAdd(mapInstance, gl) {
      map = mapInstance;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const sun = new THREE.DirectionalLight(0xffffff, 1.2);
      sun.position.set(0.5, 0.8, 1);
      scene.add(sun);
      scene.add(buildTruckModel().group);
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    onRemove() {
      if (scene) {
        scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const material = obj.material;
            if (Array.isArray(material)) material.forEach((m) => m.dispose());
            else material.dispose();
          }
        });
      }
      renderer?.dispose();
      renderer = null;
      scene = null;
      camera = null;
      map = null;
    },
    render(_gl, options) {
      const state = getState();
      if (!state || !renderer || !scene || !camera || !map) return;
      const canvas = map.getCanvas();
      renderer.getSize(size);
      if (size.x !== canvas.clientWidth || size.y !== canvas.clientHeight) {
        renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      }
      camera.projectionMatrix.copy(
        computeTruckMatrix(
          options.modelViewProjectionMatrix,
          project(state.position),
          state.headingDeg ?? 0,
        ),
      );
      renderer.render(scene, camera);
    },
  };
}
