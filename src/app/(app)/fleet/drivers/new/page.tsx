"use client";

// Task 3.3 (TASKS.md), UI/UX upgrade. Add Driver with the complete
// profile (name, role, phone, CDL + expiry, assigned truck) - the
// fields are the shared DriverProfileFields, same as the detail
// editor. The photo comes after saving, on the driver's own screen.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import DriverProfileFields, {
  EMPTY_DRIVER_PROFILE,
  driverProfileToPayload,
  type DriverProfileValues,
} from "@/components/DriverProfileFields";
import type { Driver, Truck } from "@/types/entities";

export default function NewDriverPage() {
  usePageTitle("Add driver");
  const router = useRouter();
  const [values, setValues] = useState<DriverProfileValues>(EMPTY_DRIVER_PROFILE);
  const trucks = usePickerList<Truck>("trucks");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const driver = await apiClient.create<Driver>("drivers", driverProfileToPayload(values));
      router.push(`/fleet/drivers/${driver.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Add driver"
        purpose="A full driver profile — how to reach them, their CDL, and their truck — so loads and logs can tie to a person, not just a name."
      />
      <form onSubmit={handleSubmit}>
        <DriverProfileFields values={values} onChange={setValues} trucks={trucks} />

        <p className="row-sub">
          After saving, you&apos;ll land on the driver&apos;s page — add their photo there.
        </p>

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save driver"}
        </button>
      </form>
      <p>
        <Link href="/fleet/drivers">Back to drivers</Link>
      </p>
    </div>
  );
}
