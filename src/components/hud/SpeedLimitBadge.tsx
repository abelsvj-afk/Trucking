"use client";

// Road-sign style posted-limit badge (Block C). Rendered ONLY when a real limit is known -
// the caller passes null otherwise and nothing is drawn. White plate, black border, big
// numerals, legible in glare at a 10-second glance. The label says where it comes from.

export default function SpeedLimitBadge({ limitMph }: { limitMph: number | null }) {
  if (limitMph === null) return null;
  return (
    <div className="speed-limit-badge" role="img" aria-label={`Posted speed limit ${limitMph} miles per hour`}>
      <span className="speed-limit-badge-top" aria-hidden="true">SPEED<br />LIMIT</span>
      <span className="speed-limit-badge-num" aria-hidden="true">{limitMph}</span>
    </div>
  );
}
