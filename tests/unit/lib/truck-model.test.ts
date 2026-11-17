// The 3D truck is a REAL model (owner 2026-11-17: "actually be a 3D
// object. Not just a flat something."): a low-poly semi built from
// boxes and cylinders at true scale. These tests pin its shape: real
// proportions, ten wheels, the trailer behind the tractor, the ground
// under the wheels.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  buildTruckModel,
  TRUCK_HEIGHT_M,
  TRUCK_LENGTH_M,
  TRUCK_WIDTH_M,
} from "@/lib/truck-model";

describe("buildTruckModel", () => {
  it("is a real 3D rig: 22 m long, 2.6 m wide, ~4.3 m tall, standing on the ground", () => {
    const { group } = buildTruckModel();
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    expect(size.z).toBeCloseTo(TRUCK_LENGTH_M, 0);
    expect(size.x).toBeCloseTo(TRUCK_WIDTH_M, 1);
    expect(size.y).toBeCloseTo(TRUCK_HEIGHT_M, 0);
    expect(box.min.y).toBeCloseTo(0, 1); // wheels touch the ground
  });

  it("faces +Z: the tractor's nose is the front, the trailer's rear doors are the back", () => {
    const { group } = buildTruckModel();
    const box = new THREE.Box3().setFromObject(group);
    expect(box.max.z).toBeCloseTo(11, 0);
    expect(box.min.z).toBeCloseTo(-11, 0);
  });

  it("has a cab, a hood, a box trailer, and ten wheels — all real geometry with depth", () => {
    const { cab, trailer, wheels } = buildTruckModel();
    expect(cab).toBeDefined();
    expect(trailer).toBeDefined();
    expect(wheels).toHaveLength(10);
    for (const mesh of [cab, trailer, ...wheels]) {
      const b = new THREE.Box3().setFromObject(mesh);
      const s = new THREE.Vector3();
      b.getSize(s);
      expect(s.x).toBeGreaterThan(0);
      expect(s.y).toBeGreaterThan(0);
      expect(s.z).toBeGreaterThan(0);
    }
  });
});
