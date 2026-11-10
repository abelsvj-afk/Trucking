"use client";

// Shared design-system ReasonField (spec §2.2/§2.6, Phase 1): the
// required "why are you fixing this?" control — quick chips plus a
// free-text input. A fix is valid only with a non-empty reason; the
// component exposes BOTH the value and its validity on every change
// (onChange(value, isValid)) so the caller's save button can stay
// disabled until a reason exists — the ELD-style discipline the day
// log editor adopts in a later phase. Presentational: no saving here.
import Field from "./Field";

export const REASON_CHIPS = ["Forgot to log it", "Wrong status", "Wrong time", "Entered late"] as const;

export function reasonIsValid(value: string): boolean {
  return value.trim().length > 0;
}

export default function ReasonField({
  value,
  onChange,
  label = "Why are you fixing this? (required)",
  id = "reason-field-input",
}: {
  value: string;
  onChange: (value: string, isValid: boolean) => void;
  label?: string;
  id?: string;
}) {
  const emit = (next: string) => onChange(next, reasonIsValid(next));
  return (
    <div>
      <Field label={label} htmlFor={id}>
        <input id={id} type="text" value={value} onChange={(e) => emit(e.target.value)} />
      </Field>
      <div className="reason-field-chips">
        {REASON_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="reason-chip"
            aria-pressed={value === chip}
            onClick={() => emit(chip)}
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  );
}
