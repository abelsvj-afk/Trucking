"use client";

// DriverEditForm — extracted from the Driver detail page (UI/UX Phase 4,
// spec §2.4): ONE form component, two hosts — the detail page's
// Edit Sheet (in-place editing) and the standalone /edit route
// (kept alive for deep links, incl. Abel's). Saving calls the
// caller's onSaved with the updated record; each host decides
// what that means (close the sheet / return to the detail page).

import {useState, type FormEvent} from "react";
import {apiClient, ApiClientError} from "@/lib/api-client";
import {usePickerList} from "@/lib/use-picker-list";
import {useToast} from "@/components/Toast";
import DriverProfileFields, {
  driverProfileFromDriver,
  driverProfileToPayload,
  type DriverProfileValues,
} from "@/components/DriverProfileFields";
import type {Driver, Trailer, Truck} from "@/types/entities";

export default function DriverEditForm({ driver, onSaved }: { driver: Driver; onSaved: (driver: Driver) => void }) {
  const toast = useToast();
  const [values, setValues] = useState<DriverProfileValues>(() => driverProfileFromDriver(driver));
  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Driver>("drivers", driver.id, driverProfileToPayload(values));
      onSaved(updated);
      setSaved(true);
      toast.success("Saved");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <DriverProfileFields values={values} onChange={setValues} trucks={trucks} trailers={trailers} />

      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Saved.</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
