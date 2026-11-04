"use client";

// GAP-03: add a facility by hand — the facts he already knows
// about a place, in his words.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import type { Facility } from "@/types/entities";

export default function NewFacilityPage() {
  usePageTitle("Add facility");
  const router = useRouter();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [kind, setKind] = useState("both");
  const [checkinNotes, setCheckinNotes] = useState("");
  const [parkingNotes, setParkingNotes] = useState("");
  const [detentionNotes, setDetentionNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiClient.create<Facility>("facilities", {
        name,
        city: city || undefined,
        state: state ? state.toUpperCase() : undefined,
        kind,
        checkin_notes: checkinNotes || undefined,
        parking_notes: parkingNotes || undefined,
        detention_notes: detentionNotes || undefined,
      });
      router.push("/more/facilities");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Add facility"
        purpose="A place you run to — and what you know about it, so the next visit starts smarter."
      />
      <form onSubmit={handleSubmit}>
        <label htmlFor="name">Facility name</label>
        <input id="name" value={name} onChange={(event) => setName(event.target.value)} required />

        <label htmlFor="city">City</label>
        <input id="city" value={city} onChange={(event) => setCity(event.target.value)} />

        <label htmlFor="state">State (two letters)</label>
        <input
          id="state"
          maxLength={2}
          value={state}
          onChange={(event) => setState(event.target.value)}
        />

        <label htmlFor="kind">It is a</label>
        <select id="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="both">Shipper and receiver</option>
          <option value="shipper">Shipper (pickup)</option>
          <option value="receiver">Receiver (delivery)</option>
        </select>

        <label htmlFor="checkin_notes">Check-in — how it works there</label>
        <input
          id="checkin_notes"
          value={checkinNotes}
          onChange={(event) => setCheckinNotes(event.target.value)}
        />

        <label htmlFor="parking_notes">Parking — overnight reality</label>
        <input
          id="parking_notes"
          value={parkingNotes}
          onChange={(event) => setParkingNotes(event.target.value)}
        />

        <label htmlFor="detention_notes">Detention — how it really goes there</label>
        <input
          id="detention_notes"
          value={detentionNotes}
          onChange={(event) => setDetentionNotes(event.target.value)}
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
