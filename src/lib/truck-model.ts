// The truck on the driving map, as a REAL 3D object (owner 2026-11-17):
// a low-poly semi tractor + 53-ft trailer built from boxes and
// cylinders in three.js, at true scale in meters. It is rendered
// through a MapLibre custom WebGL layer (see truck-map-layer.ts), so
// it has angle and depth — cab, hood, trailer, wheels, stacks —
// instead of a flat drawing. Stylized on purpose: no GLB asset is
// bundled, so a detailed model can replace this builder later
// through the same layer without touching the map code.
//
// Frame: X right, Y up, Z FORWARD (direction of travel). Origin at
// ground level under the middle of the rig. Forward is +Z; the layer
// rotates the group to the truck's heading.

import * as THREE from "three";

/** A standard US semi rig: tractor + 53-ft trailer, about 22 m nose to tail. */
export const TRUCK_LENGTH_M = 22;
export const TRUCK_WIDTH_M = 2.6;
export const TRUCK_HEIGHT_M = 4.3;
/** Trailer: 53 ft long, 2.6 m wide, 2.9 m tall, floor 1.15 m off the ground. */
export const TRAILER_LENGTH_M = 16.15;

export interface TruckModelParts {
  group: THREE.Group;
  /** The tractor (hood + cab + chassis + tanks + stacks). */
  tractor: THREE.Group;
  /** The box trailer. */
  trailer: THREE.Mesh;
  /** Ten wheels: 2 steer + 4 drive + 4 trailer. */
  wheels: THREE.Mesh[];
  /** The cab, so a caller can find it (tests). */
  cab: THREE.Mesh;
}

const CAB_COLOR = 0xf2b705; // bright brand gold (owner 2026-11-19: "the truck is dark ... it should be bright")
const HOOD_COLOR = 0xf2b705;
const CHASSIS_COLOR = 0x4b5563;
const TRAILER_COLOR = 0xf8fafc; // bright white box — reads on day and night tiles
const TRAILER_REAR_COLOR = 0xf2b705; // gold rear doors
const WINDOW_COLOR = 0x60a5fa;
const TANK_COLOR = 0x9ca3af; // aluminium
const STACK_COLOR = 0x6b7280;
const WHEEL_COLOR = 0x1f2937;
const MARKER_COLOR = 0xf59e0b; // amber front markers

function box(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  mesh.position.set(x, y, z);
  return mesh;
}

function cylinderZ(r: number, len: number, color: number, x: number, y: number, z: number): THREE.Mesh {
  // CylinderGeometry's axis is Y; rotate to lie along Z (fuel tanks).
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), new THREE.MeshLambertMaterial({ color }));
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

function cylinderX(r: number, len: number, color: number, x: number, y: number, z: number): THREE.Mesh {
  // Axis along X (a wheel on its axle).
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), new THREE.MeshLambertMaterial({ color }));
  mesh.rotation.z = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

export function buildTruckModel(): TruckModelParts {
  const group = new THREE.Group();
  const tractor = new THREE.Group();
  const wheels: THREE.Mesh[] = [];

  // --- Tractor: front bumper z = +11, fifth wheel z = +5.15 ---
  // Hood: low, long nose. Cab: tall sleeper behind it.
  const hood = box(2.4, 1.7, 2.7, HOOD_COLOR, 0, 1.75, 9.65);
  tractor.add(hood);
  const cab = box(2.5, 3.4, 3.15, CAB_COLOR, 0, 2.6, 6.72);
  tractor.add(cab);
  // Windshield: dark band on the cab's front face.
  tractor.add(box(2.2, 0.9, 0.08, WINDOW_COLOR, 0, 3.3, 8.32));
  // Chassis rail under the tractor.
  tractor.add(box(2.2, 0.35, 5.8, CHASSIS_COLOR, 0, 0.72, 8.2));
  // Fifth-wheel plate the trailer sits on.
  tractor.add(box(1.8, 0.12, 1.2, CHASSIS_COLOR, 0, 1.12, 4.6));
  // Fuel tanks (aluminium cylinders along each side) + exhaust stacks.
  // Tanks sit inside the 2.6 m width (x ±0.95, r 0.35 -> ±1.30).
  tractor.add(cylinderZ(0.35, 1.6, TANK_COLOR, -0.95, 0.85, 6.5));
  tractor.add(cylinderZ(0.35, 1.6, TANK_COLOR, 0.95, 0.85, 6.5));
  const stackL = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 8), new THREE.MeshLambertMaterial({ color: STACK_COLOR }));
  stackL.position.set(-1.2, 2.5, 5.3);
  tractor.add(stackL);
  const stackR = stackL.clone();
  stackR.position.x = 1.2;
  tractor.add(stackR);
  // Amber markers on the hood's front face.
  const markerMat = new THREE.MeshLambertMaterial({ color: MARKER_COLOR, emissive: MARKER_COLOR, emissiveIntensity: 0.6 });
  for (const x of [-0.9, 0.9]) {
    const marker = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.15, 0.05), markerMat);
    marker.position.set(x, 1.6, 11.02);
    tractor.add(marker);
  }
  // Wheels: steer axle + two drive axles (tractor), two axles (trailer).
  for (const z of [9.8, 6.3, 4.9, -8.6, -10.0]) {
    for (const x of [-1.05, 1.05]) {
      const wheel = cylinderX(0.5, 0.4, WHEEL_COLOR, x, 0.5, z);
      wheels.push(wheel);
      group.add(wheel);
    }
  }
  group.add(tractor);

  // --- Trailer: 53 ft, front z = +5.15, rear z = -11 ---
  const trailer = box(TRUCK_WIDTH_M, 2.9, TRAILER_LENGTH_M, TRAILER_COLOR, 0, 2.6, -2.925);
  group.add(trailer);
  // Rear doors: a darker gold face on the trailer's rear.
  group.add(box(2.4, 2.7, 0.06, TRAILER_REAR_COLOR, 0, 2.6, -11.03));
  // Landing gear under the trailer's front.
  group.add(box(0.15, 1.15, 0.15, CHASSIS_COLOR, -0.9, 0.57, 3.8));
  group.add(box(0.15, 1.15, 0.15, CHASSIS_COLOR, 0.9, 0.57, 3.8));

  return { group, tractor, trailer, wheels, cab };
}
