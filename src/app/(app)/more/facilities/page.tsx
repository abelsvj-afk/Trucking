"use client";

// GAP-03 (Fresh-Eyes Register 2026-11-02): the places he actually
// goes, remembered — what check-in is like, where the parking is,
// how detention really goes there. Facilities arrive from rate
// cons (Abel proposes them) and his after-visit words; this page
// is where he can see and correct what the app remembers.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import type { Facility } from "@/types/entities";

export default function FacilitiesListPage() {
  usePageTitle("Facilities");
  const { state, retry } = useApiList<Facility>("facilities");

  return (
    <div>
      <PageHeader
        title="Facilities"
        purpose="The places you pick up and deliver — what you learned there, kept for the next visit."
        action={
          <Link href="/more/facilities/new" className="page-action">
            Add facility
          </Link>
        }
      />

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No facilities yet"
          message="Facilities appear as your rate cons name them and Abel proposes them — or add one now with what you already know about the place."
          action={<Link href="/more/facilities/new">Add your first facility</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((facility) => {
            const place = [facility.city, facility.state].filter(Boolean).join(", ");
            const facts = [
              facility.checkin_notes && `Check-in: ${facility.checkin_notes}`,
              facility.parking_notes && `Parking: ${facility.parking_notes}`,
              facility.detention_notes && `Detention: ${facility.detention_notes}`,
              facility.hours_notes && `Hours: ${facility.hours_notes}`,
            ].filter(Boolean);
            return (
              <li key={facility.id}>
                <span className="row-title">{facility.name}</span>
                <span className="row-sub">
                  {[place, `${facility.visit_count} visit${facility.visit_count === 1 ? "" : "s"}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {facts.map((fact) => (
                  <span key={fact} className="row-sub">
                    {fact}
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
