"use client";

// "Your pay terms" card (UI/UX Phase 4, spec §2.4): the terms sit
// next to their numbers at the top of Driver pay, rendered FROM the
// live pay-profile data (the same source PayTermsSettings reads —
// nothing is hardcoded here). Edit opens the existing
// PayTermsSettings form in a Sheet on this page; Settings keeps its
// own copy untouched. An UNSET miles basis keeps the range/flag rule:
// the card says the basis isn't set and figures show a range — it
// never dresses a guess up as one number.

import { useState } from "react";
import Card from "@/components/Card";
import Sheet from "@/components/Sheet";
import PayTermsSettings from "@/components/settings/PayTermsSettings";
import { describeTerms, type PayTerms } from "@/lib/pay-projection";
import { isContractor, taxSetAsideBps, TAX_SET_ASIDE_DEFAULT_NOTE, workerTypeLabel } from "@/lib/tax-set-aside";

export function basisLabel(terms: PayTerms): string {
  switch (terms.mile_basis) {
    case "all":
      return "all miles";
    case "loaded":
      return "loaded miles only";
    case "practical":
      return "practical miles";
    default:
      return "miles basis not set — pay by the mile shows as a range";
  }
}

export default function PayTermsCard({ terms }: { terms: PayTerms | null }) {
  const [editOpen, setEditOpen] = useState(false);
  // The set-aside has no gross to price here - the card names the rate
  // and the default; the dollar figure lives on the Home card and the
  // Paychecks page, where a gross exists.
  const workerLabel = terms ? workerTypeLabel(terms.worker_type ?? null) : null;
  const setAsideBps = terms && isContractor(terms.worker_type ?? null) ? taxSetAsideBps(terms.tax_set_aside_bps ?? null) : null;
  const setAsideDefault = terms?.tax_set_aside_bps == null;
  return (
    <Card ariaLabel="Your pay terms" className="pay-terms-card">
      {terms ? (
        <p>
          Your pay terms — {describeTerms(terms)}, {basisLabel(terms)} ({terms.employer_name})
          {workerLabel ? ` · ${workerLabel}` : " · tax status not set"}
          {setAsideBps !== null
            ? ` · set aside ${setAsideBps / 100}% of each check for taxes${setAsideDefault ? ` (${TAX_SET_ASIDE_DEFAULT_NOTE})` : ""}`
            : ""}
          .{" "}
          <button type="button" className="page-action" onClick={() => setEditOpen(true)}>
            Edit pay terms
          </button>
        </p>
      ) : (
        <p>
          You haven&apos;t entered pay terms yet.{" "}
          <button type="button" className="page-action" onClick={() => setEditOpen(true)}>
            Add pay terms
          </button>
        </p>
      )}
      {editOpen && (
        <Sheet title="Your pay terms" onClose={() => setEditOpen(false)}>
          <PayTermsSettings />
        </Sheet>
      )}
    </Card>
  );
}
