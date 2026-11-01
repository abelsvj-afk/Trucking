"use client";

// Task 3.1 (TASKS.md), UI/UX upgrade. New truck form: identity
// (including the truck TYPE picklist) + the shared profile fields.
// Field-level errors render inline, per docs/design/ui-ux.md's Errors
// section - never a raw error code. The photo comes after saving, on
// the truck's own screen - a photo needs the truck to exist first.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import TruckProfileFields, {
  EMPTY_TRUCK_PROFILE,
  truckProfileToPayload,
  type TruckProfileValues,
} from "@/components/TruckProfileFields";
import TruckIdentityFields, {
  EMPTY_TRUCK_IDENTITY,
  truckIdentityToPayload,
  type TruckIdentityValues,
} from "@/components/TruckIdentityFields";
import type { Truck } from "@/types/entities";

export default function NewTruckPage() {
  usePageTitle("Add truck");
  const router = useRouter();
  const [identity, setIdentity] = useState<TruckIdentityValues>(EMPTY_TRUCK_IDENTITY);
  const [profile, setProfile] = useState<TruckProfileValues>(EMPTY_TRUCK_PROFILE);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const truck = await apiClient.create<Truck>("trucks", {
        ...truckIdentityToPayload(identity),
        ...truckProfileToPayload(profile),
      });
      router.push(`/fleet/trucks/${truck.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Add truck"
        purpose="One truck, fully described — type, size, and what's in the cab — so planning, maintenance, and the assistant all work from the same truth."
      />
      <form onSubmit={handleSubmit}>
        <TruckIdentityFields values={identity} onChange={setIdentity} />

        <TruckProfileFields values={profile} onChange={setProfile} />

        <p className="row-sub">
          After saving, you&apos;ll land on the truck&apos;s page — snap its photo there so the fleet
          list shows the real truck.
        </p>

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save truck"}
        </button>
      </form>
      <p>
        <Link href="/fleet/trucks">Back to trucks</Link>
      </p>
    </div>
  );
}
