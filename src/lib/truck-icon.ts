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
