// Drive-map camera math (3D view, owner 2026-11-17): a navigation-style
// tilted perspective instead of the flat top-down view. Pure — the
// component applies the result to MapLibre, the math is tested here.
//
// The truck sits at the bottom of the screen (offset pushes the map
// centre down) so the road ahead and the upcoming turns have the open
// space above it. 3D navigation must be heading-up: the bearing is
// the truck's heading, so the road ahead is always up-screen.
//
// Follow zoom and bearing belong to FOLLOWING, not to 3D: a flat map
// that is following the truck still has to sit at street level and
// rotate with his heading, or it reads as a zoomed-out north-up state
// view with the truck pointing straight up-screen. Only pitch and the
// down-screen offset are 3D-only.

/** MapLibre pitch for the 3D driving view (MapLibre's own max is 60). */
export const DRIVE_MAP_PITCH_3D = 60;
/** Flat top-down view: no tilt. */
export const DRIVE_MAP_PITCH_FLAT = 0;
/** Fraction of the map height the centre is pushed down in 3D, putting the truck ~72% down the screen. */
export const DRIVE_MAP_TRUCK_OFFSET_FRACTION = 0.22;
/** Follow zoom in 3D when the caller sets none — close enough to read the road ahead like a GPS. */
export const DRIVE_MAP_FOLLOW_ZOOM_3D = 14.5;

export interface DriveMapCameraInput {
  view3d: boolean;
  headingDeg: number | null;
  headingUp: boolean;
  followZoom?: number;
  containerHeightPx: number;
  /** True while the map is following the truck. When false the camera keeps its zoom. */
  follow?: boolean;
}

export interface DriveMapCamera {
  pitch: number;
  /** Null = leave the bearing alone (no heading yet, or not heading-up). */
  bearing: number | null;
  /** Null = leave the zoom alone. */
  zoom: number | null;
  /** Screen offset of the map centre, [x, y] px. Positive y moves the truck down-screen. */
  offset: [number, number];
}

export function driveMapCamera({
  view3d,
  headingDeg,
  headingUp,
  followZoom,
  containerHeightPx,
  follow = true,
}: DriveMapCameraInput): DriveMapCamera {
  const bearing = follow && headingUp && headingDeg !== null ? headingDeg : null;
  const zoom = follow ? (followZoom ?? DRIVE_MAP_FOLLOW_ZOOM_3D) : null;
  if (!view3d) {
    return { pitch: DRIVE_MAP_PITCH_FLAT, bearing, zoom, offset: [0, 0] };
  }
  return {
    pitch: DRIVE_MAP_PITCH_3D,
    bearing,
    zoom,
    offset: [0, Math.round(Math.max(0, containerHeightPx) * DRIVE_MAP_TRUCK_OFFSET_FRACTION)],
  };
}
