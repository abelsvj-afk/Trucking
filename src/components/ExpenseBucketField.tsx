"use client";

// The expense bucket picker (expense buckets spec 2026-11-09), shared
// by the Add and Edit expense forms: which kind of money is this -
// his own business's cost, or a pay deduction the company takes out
// of his check? Picking pay deduction says plainly what it does
// before anything is saved.

import type { ExpenseBucket } from "@/lib/expense-buckets";

export default function ExpenseBucketField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ExpenseBucket;
  onChange: (bucket: ExpenseBucket) => void;
}) {
  return (
    <>
      <label htmlFor={id}>Which kind of cost is this?</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value as ExpenseBucket)}>
        <option value="business">Business expense — my company&apos;s cost</option>
        <option value="pay_deduction">Pay deduction — the company takes it out of my check</option>
      </select>
      {value === "pay_deduction" && (
        <p role="note">
          This comes out of your check: it will show on the Paychecks page as its own line, with the description as
          the reason, and your expected pay for that week drops by this amount. Put the reason in the description —
          that&apos;s the words you&apos;ll see there.
        </p>
      )}
    </>
  );
}
