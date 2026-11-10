// Shared design-system SegmentedStatus (spec §2.6, Phase 1): the
// segmented control for the four duty statuses and for rendition
// toggles (Page | Original photo | Scan). Buttons in a grid, the
// pressed one filled with button gold + near-black text. Controlled
// and presentational: the caller owns the value.
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export default function SegmentedStatus<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  columns,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  columns?: number;
}) {
  return (
    <div
      className="segmented-status"
      role="group"
      aria-label={ariaLabel}
      style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, 1fr)` }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
