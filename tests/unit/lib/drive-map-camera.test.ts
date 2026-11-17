import { describe, expect, it } from "vitest";
import {
  DRIVE_MAP_FOLLOW_ZOOM_3D,
  DRIVE_MAP_PITCH_3D,
  DRIVE_MAP_PITCH_FLAT,
  driveMapCamera,
} from "@/lib/drive-map-camera";

describe("drive map camera (3D view)", () => {
  const base = { headingDeg: 90, headingUp: true, containerHeightPx: 500 } as const;
  it("3D: tilted to 60, bearing is the heading, truck pushed down-screen, follow zoom 15 when none set", () => {
    const cam = driveMapCamera({ view3d: true, followZoom: undefined, ...base });
    expect(cam.pitch).toBe(DRIVE_MAP_PITCH_3D);
    expect(cam.bearing).toBe(90);
    expect(cam.zoom).toBe(DRIVE_MAP_FOLLOW_ZOOM_3D);
    expect(cam.offset).toEqual([0, 110]); // 22% of 500
  });
  it("3D: a caller zoom wins over the default", () => {
    const cam = driveMapCamera({ view3d: true, followZoom: 12, ...base });
    expect(cam.zoom).toBe(12);
  });
  it("3D with no heading yet: still tilted, bearing untouched", () => {
    const cam = driveMapCamera({ view3d: true, headingDeg: null, headingUp: true, containerHeightPx: 500 });
    expect(cam.pitch).toBe(DRIVE_MAP_PITCH_3D);
    expect(cam.bearing).toBeNull();
  });
  it("3D without heading-up: bearing untouched (the icon rotates instead)", () => {
    const cam = driveMapCamera({ view3d: true, headingDeg: 90, headingUp: false, containerHeightPx: 500 });
    expect(cam.bearing).toBeNull();
    expect(cam.pitch).toBe(DRIVE_MAP_PITCH_3D);
  });
  it("flat: no tilt, no offset, bearing and zoom untouched", () => {
    const cam = driveMapCamera({ view3d: false, followZoom: 14, ...base });
    expect(cam.pitch).toBe(DRIVE_MAP_PITCH_FLAT);
    expect(cam.offset).toEqual([0, 0]);
    expect(cam.bearing).toBeNull();
    expect(cam.zoom).toBeNull();
  });
  it("offset scales with the map height and never goes negative", () => {
    expect(driveMapCamera({ view3d: true, headingDeg: null, headingUp: true, containerHeightPx: 200 }).offset).toEqual([0, 44]);
    expect(driveMapCamera({ view3d: true, headingDeg: null, headingUp: true, containerHeightPx: -50 }).offset).toEqual([0, 0]);
  });
});
