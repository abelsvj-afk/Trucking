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
  return (
    <Card ariaLabel="Your pay terms" className="pay-terms-card">
      {terms ? (
        <p>
          Your pay terms — {describeTerms(terms)}, {basisLabel(terms)} ({terms.employer_name}).{" "}
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
