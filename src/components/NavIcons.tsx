// Small hand-authored icon set for the bottom tab nav (layout.tsx), per
// docs/design/ui-ux.md's visual design system - a real icon per tab
// instead of text-only, purely decorative (aria-hidden, the tab's own
// link text is what screen readers announce) so this stays additive to
// task 3.12's accessibility work, not a change to it. Inline SVG, no
// icon-library dependency (CLAUDE.md's Dependency Rule - five outline
// glyphs don't justify a new package).

type IconProps = { className?: string };

const common = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function HomeIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

export function LoadsIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.25" />
    </svg>
  );
}

export function FleetIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M3 16V7a1 1 0 0 1 1-1h9v10" />
      <path d="M13 10h4.5l3.5 3.5V16h-8" />
      <circle cx="7.5" cy="17.5" r="1.75" />
      <circle cx="17" cy="17.5" r="1.75" />
    </svg>
  );
}

export function MoneyIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v9M14.5 9.75c0-1.1-1.1-2-2.5-2s-2.5.9-2.5 2 1.1 1.75 2.5 1.75 2.5.65 2.5 1.75-1.1 2-2.5 2-2.5-.9-2.5-2" />
    </svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
