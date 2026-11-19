// Spoken hazard warnings ahead of time (owner 2026-11-19: the
// reference app "speaks it out ahead of time that it's coming up").
// Pure. Traffic and low bridges are spoken by the Drive page's live
// poll; this is road work, from the state work-zone feeds.

/** "Road work ahead in 1.8 miles." plus the posted restriction when his truck exceeds it. */
export function roadWorkCallout(milesAway: number, label: string): string {
  const miles = Math.max(0, milesAway);
  const distance = miles < 0.4 ? "just ahead" : `ahead in ${miles.toFixed(1)} miles`;
  const over = /restriction over your truck/i.test(label);
  return over
    ? `Road work ${distance}, with a posted restriction your truck is over. Check the signs.`
    : `Road work ${distance}.`;
}
