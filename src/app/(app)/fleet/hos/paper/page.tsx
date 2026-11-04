"use client";

// Paper logs (docs/design/driver-hud.md §6): photograph a sheet, the grid
// is read, and he reviews the recreated day before anything is saved.
// Sheets sent to Abel on Telegram show up here too. If reading is off or
// fails, the sheet is still stored and he can fill in the day by hand on
// the review screen - both abilities, one place.

import { useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import { useLiveVersion } from "@/lib/use-live";
import { formatDateTime } from "@/lib/time";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import type { Document, Truck } from "@/types/entities";
import type { PaperLogListItem } from "@/types/paper-logs";

export default function PaperLogsPage() {
  usePageTitle("Paper logs");
  const router = useRouter();
  const trucks = usePickerList<Truck>("trucks");
  const [truckId, setTruckId] = useState("");
  const [items, setItems] = useState<PaperLogListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveVersion = useLiveVersion(["documents", "duty_logs"]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .paperLogs()
      .then((res) => {
        if (!cancelled) setItems(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(err instanceof ApiClientError ? err.message : "Couldn't load your sheets.");
      });
    return () => {
      cancelled = true;
    };
  }, [liveVersion]);

  const chosenTruck = truckId || trucks[0]?.id || "";

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!chosenTruck) {
      setError("Add your truck first (Fleet → Trucks) — sheets are filed under the truck.");
      return;
    }
    setError(null);
    setBusy("Uploading the photo…");
    let doc: Document;
    try {
      doc = await apiClient.uploadDocument<Document>({
        file,
        related_entity_type: "truck",
        related_entity_id: chosenTruck,
        file_name: file.name || "paper-log.jpg",
      });
    } catch (err) {
      setBusy(null);
      setError(err instanceof ApiClientError ? err.message : "No signal — the photo didn't upload. Try again.");
      return;
    }
    setBusy("Reading the grid…");
    try {
      await apiClient.readPaperLog(doc.id);
    } catch {
      // Stored either way: the review screen offers a re-read or entry by hand.
    }
    router.push(`/fleet/hos/paper/${doc.id}`);
  }

  return (
    <div>
      <PageHeader
        title="Paper logs"
        purpose="Photograph a paper log sheet, check the day it reads, and add it to your hours."
      />
      <section aria-label="Add a sheet" className="paper-add">
        {trucks.length > 1 && (
          <>
            <label htmlFor="paper-truck">Truck</label>
            <select id="paper-truck" value={chosenTruck} onChange={(e) => setTruckId(e.target.value)}>
              {trucks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.unit_number}
                </option>
              ))}
            </select>
          </>
        )}
        <label className="page-action paper-camera">
          {busy ?? "Photograph a sheet"}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFile}
            disabled={busy !== null}
            className="visually-hidden"
          />
        </label>
        <p className="row-sub">
          Lay the sheet flat, fill the frame with the grid, avoid glare. You check every stretch before it&apos;s saved.
        </p>
        {error && <p role="alert">{error}</p>}
      </section>

      <section aria-label="Your sheets">
        <h2>Your sheets</h2>
        {listError && <ListError message={listError} onRetry={() => window.location.reload()} />}
        {!listError && items === null && <ListLoading />}
        {items && items.length === 0 && <p>No paper log sheets yet.</p>}
        {items && items.length > 0 && (
          <ul className="paper-list">
            {items.map((item) => (
              <li key={item.id}>
                <Link href={`/fleet/hos/paper/${item.id}`}>
                  <strong>{item.log_date ?? "Date not read"}</strong>
                  <span className="row-sub">
                    {item.saved ? "In your log" : item.read ? "Read — needs your review" : "Not read yet"} · photographed{" "}
                    {formatDateTime(item.uploaded_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
