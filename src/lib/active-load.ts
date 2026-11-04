// Which load is "the" active load for Home (owner-operator cockpit).
// Pure. Only confirmed loads count (draft = not booked yet, completed/
// cancelled = done). Among them: the next one still ahead of today by
// delivery date (earliest pickup first); if every confirmed load's
// delivery date has passed, the most recent one - flagged overdue so the
// card can ask whether it should be marked complete, never assuming.

import type { Load } from "@/types/entities";

export interface ActiveLoad {
  load: Load;
  /** Delivery date has passed but the load is still confirmed. */
  overdue: boolean;
}

const dayOf = (value: string | null): string | null => (value ? value.slice(0, 10) : null);

/** `todayIso` is "YYYY-MM-DD" on the carrier's/viewer's calendar. */
export function pickActiveLoad(loads: Load[], todayIso: string): ActiveLoad | null {
  const live = loads.filter((l) => l.status === "confirmed" && !l.deleted_at);
  if (live.length === 0) return null;

  const ahead = live
    .filter((l) => {
      const delivery = dayOf(l.delivery_date);
      return delivery === null || delivery >= todayIso;
    })
    .sort((a, b) => (dayOf(a.pickup_date) ?? "9999-12-31").localeCompare(dayOf(b.pickup_date) ?? "9999-12-31"));
  if (ahead.length > 0) return { load: ahead[0]!, overdue: false };

  const latest = [...live].sort((a, b) =>
    (dayOf(b.delivery_date) ?? "").localeCompare(dayOf(a.delivery_date) ?? ""),
  )[0]!;
  return { load: latest, overdue: true };
}

/** A date-only value as local noon, so it can't slip a day across time zones. */
export function dateOnlyToNoon(value: string): Date {
  return new Date(`${value.slice(0, 10)}T12:00:00`);
}
