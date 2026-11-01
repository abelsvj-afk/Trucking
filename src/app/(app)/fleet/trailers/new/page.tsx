"use client";

// Task 3.2 (TASKS.md), UI/UX upgrade. Add Trailer with its full field
// set (unit, type, VIN, status) via the shared TrailerFields. The
// photo comes after saving, on the trailer's own screen.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import TrailerFields, {
  EMPTY_TRAILER,
  trailerToPayload,
  type TrailerValues,
} from "@/components/TrailerFields";
import type { Trailer } from "@/types/entities";

export default function NewTrailerPage() {
  usePageTitle("Add trailer");
  const router = useRouter();
  const [values, setValues] = useState<TrailerValues>(EMPTY_TRAILER);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const trailer = await apiClient.create<Trailer>("trailers", trailerToPayload(values));
      router.push(`/fleet/trailers/${trailer.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Add trailer"
        purpose="The trailer, described — type, VIN, and status — so equipment and maintenance records have something real to hang on."
      />
      <form onSubmit={handleSubmit}>
        <TrailerFields values={values} onChange={setValues} />

        <p className="row-sub">After saving, you&apos;ll land on the trailer&apos;s page — add its photo there.</p>

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save trailer"}
        </button>
      </form>
      <p>
        <Link href="/fleet/trailers">Back to trailers</Link>
      </p>
    </div>
  );
}
