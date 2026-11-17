// The map-layer matrix math (owner 2026-11-17: the truck must be a
// real 3D object): the model stands upright at the truck's real
// position and turns to its real heading. Pure — no GL context, no
// map instance. The identity MVP stands in for the map's matrix so
// the directions can be checked directly in Mercator space
// (x = east, y = south, z = up).

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { computeTruckMatrix, type TruckMercatorPosition } from "@/lib/truck-map-layer";

// Mercator world at lng 0 / lat 0 (the middle of the world).
const MERCATOR_EQUATOR: TruckMercatorPosition = {
  x: 0.5,
  y: 0.5,
  z: 0,
  metersPerUnit: 1 / (2 * Math.PI * 6378137),
};
const IDENTITY_MVP = new THREE.Matrix4().identity().toArray();

function direction(matrix: THREE.Matrix4, fromLocal: THREE.Vector3): THREE.Vector3 {
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
  const point = fromLocal.clone().applyMatrix4(matrix);
  return point.sub(origin).normalize();
}

describe("computeTruckMatrix", () => {
  it("puts the truck at its real Mercator position", () => {
    const m = computeTruckMatrix(IDENTITY_MVP, MERCATOR_EQUATOR, 0);
    const at = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
    expect(at.x).toBeCloseTo(0.5, 6);
    expect(at.y).toBeCloseTo(0.5, 6);
    expect(at.z).toBeCloseTo(0, 6);
  });

  it("points the model's nose (+Z) at the heading: north, east, south, west", () => {
    const cases: Array<[number, THREE.Vector3]> = [
      [0, new THREE.Vector3(0, -1, 0)],
      [90, new THREE.Vector3(1, 0, 0)],
      [180, new THREE.Vector3(0, 1, 0)],
      [270, new THREE.Vector3(-1, 0, 0)],
    ];
    for (const [heading, expected] of cases) {
      const m = computeTruckMatrix(IDENTITY_MVP, MERCATOR_EQUATOR, heading);
      const nose = direction(m, new THREE.Vector3(0, 0, 1));
      expect(nose.x).toBeCloseTo(expected.x, 5);
      expect(nose.y).toBeCloseTo(expected.y, 5);
      expect(nose.z).toBeCloseTo(expected.z, 5);
    }
  });

  it("stands the model up: local +Y is world +Z", () => {
    const m = computeTruckMatrix(IDENTITY_MVP, MERCATOR_EQUATOR, 45);
    const up = direction(m, new THREE.Vector3(0, 1, 0));
    expect(up.x).toBeCloseTo(0, 5);
    expect(up.y).toBeCloseTo(0, 5);
    expect(up.z).toBeCloseTo(1, 5);
  });

  it("scales the rig 10x true size by default (a true-scale truck is ~5 px at follow zoom)", () => {
    const m = computeTruckMatrix(IDENTITY_MVP, MERCATOR_EQUATOR, 0);
    const nose = new THREE.Vector3(0, 0, 1).applyMatrix4(m);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
    // One model meter forward, in Mercator units, at 10x exaggeration.
    const oneMeter = MERCATOR_EQUATOR.metersPerUnit * 10;
    expect(nose.distanceTo(origin)).toBeCloseTo(oneMeter, 12);
  });
});
