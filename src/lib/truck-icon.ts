// The Home/Drive map position marker (Block C, owner 2026-11-05): a top-down semi
// truck - tractor with cab and windshield, a gap at the fifth wheel, a long box
// trailer - as crisp vector SVG, pointing UP (north). The map rotates it with the
// heading. The shape has to read as a truck at a glance, so the proportions are a
// real rig's (about 1:3 wide:long) and it carries a white outline that survives
// any map tile colour and glare. Colour is the only variable (quality states).

export interface TruckIconOptions {
  /** Body fill. */
  color: string;
  /** Overall opacity (a lost fix is shown faded, never as live). */
  opacity?: number;
  /** Pixel width; height is 2.75x. */
  widthPx?: number;
}

export const TRUCK_ICON_ASPECT = 2.75;

// The same rig from behind-above (3D driving view, owner 2026-11-17):
// a rear three-quarter perspective — trailer rear face, roof and
// right side in shaded faces, the cab roof peeking past the
// trailer's far edge — pointing UP (north), the way a GPS draws
// the truck at the bottom of a tilted map. MapLibre has no 3D
// model layer, so the depth is drawn: roof lighter, side darker,
// white outlines so it survives any map tile colour and glare.
// Same options shape as truckIconSvg.
export const TRUCK_ICON_3D_ASPECT = 1.5;

export function truckIcon3dSvg({ color, opacity = 1, widthPx = 40 }: TruckIconOptions): string {
  const h = Math.round(widthPx * TRUCK_ICON_3D_ASPECT);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 72" width="${widthPx}" height="${h}" ` +
    `role="img" aria-hidden="true" focusable="false" style="opacity:${opacity};overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))">` +
    // cab roof (far end, top): sleeper top + mirrors peeking past the trailer
    `<rect x="12" y="4" width="24" height="11" rx="3" fill="#fff"/>` +
    `<rect x="14" y="6" width="20" height="8" rx="2" fill="${color}"/>` +
    `<rect x="17" y="8" width="14" height="3" rx="1" fill="#0f172a" opacity=".7"/>` +
    `<rect x="8" y="7" width="4" height="6" rx="1" fill="#334155"/>` +
    `<rect x="36" y="7" width="4" height="6" rx="1" fill="#334155"/>` +
    // trailer roof (receding up-screen): lighter face
    `<polygon points="6,28 34,28 38,15 10,15" fill="${color}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>` +
    `<polygon points="6,28 34,28 38,15 10,15" fill="#fff" opacity=".3"/>` +
    // trailer right side face: darker face, gives the depth
    `<polygon points="34,28 38,15 38,48 34,62" fill="#000" opacity=".28"/>` +
    // trailer rear face (closest to the viewer): main face
    `<rect x="6" y="28" width="28" height="34" fill="#fff"/>` +
    `<rect x="8" y="30" width="24" height="30" fill="${color}"/>` +
    `<rect x="12" y="34" width="16" height="22" fill="#fff" opacity=".25"/>` +
    // rear-door centre line + handles
    `<rect x="19" y="30" width="2" height="30" fill="#fff" opacity=".45"/>` +
    `<rect x="12" y="42" width="5" height="2" rx="1" fill="#0f172a" opacity=".6"/>` +
    `<rect x="26" y="42" width="5" height="2" rx="1" fill="#0f172a" opacity=".6"/>` +
    // wheels peeking out at the bottom corners + bumper
    `<rect x="2" y="50" width="4" height="12" rx="1" fill="#1e293b"/>` +
    `<rect x="38" y="50" width="4" height="12" rx="1" fill="#1e293b"/>` +
    `<rect x="8" y="62" width="28" height="4" rx="1" fill="#1e293b"/>` +
    `</svg>`
  );
}

export function truckIconSvg({ color, opacity = 1, widthPx = 26 }: TruckIconOptions): string {
  const h = Math.round(widthPx * TRUCK_ICON_ASPECT);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 88" width="${widthPx}" height="${h}" ` +
    `role="img" aria-hidden="true" focusable="false" style="opacity:${opacity};overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">` +
    // trailer (rear, bottom): long box, white outline then fill
    `<rect x="3" y="36" width="26" height="50" rx="3" fill="#fff"/>` +
    `<rect x="5" y="38" width="22" height="46" rx="2" fill="${color}"/>` +
    `<rect x="9" y="42" width="14" height="38" rx="1" fill="#fff" opacity=".25"/>` +
    // fifth-wheel / kingpin gap line
    `<rect x="12" y="30" width="8" height="8" fill="#334155"/>` +
    // tractor (front, top): rounded cab
    `<rect x="4" y="2" width="24" height="32" rx="6" fill="#fff"/>` +
    `<rect x="6" y="4" width="20" height="28" rx="4" fill="${color}"/>` +
    // windshield + roof sleeper
    `<rect x="9" y="7" width="14" height="7" rx="2" fill="#0f172a"/>` +
    `<rect x="9" y="18" width="14" height="10" rx="2" fill="#fff" opacity=".3"/>` +
    // mirrors
    `<rect x="0" y="9" width="4" height="6" rx="1" fill="#334155"/>` +
    `<rect x="28" y="9" width="4" height="6" rx="1" fill="#334155"/>` +
    // tires peeking out
    `<rect x="1" y="50" width="3" height="10" rx="1" fill="#1e293b"/><rect x="28" y="50" width="3" height="10" rx="1" fill="#1e293b"/>` +
    `<rect x="1" y="66" width="3" height="10" rx="1" fill="#1e293b"/><rect x="28" y="66" width="3" height="10" rx="1" fill="#1e293b"/>` +
    `</svg>`
  );
}
