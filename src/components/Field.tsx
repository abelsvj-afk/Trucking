// Shared design-system Field (spec §2.6, Phase 1): label-above-input
// wrapper. Inputs render at 50px (the .ds-field rule in
// 03-components.css); a validation error shows as danger-red text
// under the field, never colour alone. Presentational only — the
// caller owns the input element and its value.
import type { ReactNode } from "react";

export default function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="ds-field">
      <label className="ds-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="ds-field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="ds-field-hint">{hint}</p>
      ) : null}
    </div>
  );
}
