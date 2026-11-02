import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import { getResearchConfig } from "@/services/research/config";
import { flushHeldDeliveries } from "@/services/research/run-research";
import type { TelegramNotifier } from "@/services/telegram/notify";

const config = getResearchConfig({} as NodeJS.ProcessEnv);

// 2026-11-02 is EST (UTC-5). 03:00Z = 22:00 ET - inside the default
// 21:00-06:00 quiet window; 17:00Z = 12:00 ET - parked daytime.
const NIGHT_ET = new Date("2026-11-02T03:00:00Z");
const DAY_ET = new Date("2026-11-02T17:00:00Z");
const QUIET_END_UTC = "2026-11-02T11:00:00.000Z"; // 06:00 EST

interface HeldRow {
  id: string;
  topic: string;
  title: string;
  headline: string;
  counter_move: string;
  takeaway: string;
  delivery_class: string;
}

function heldRow(partial: Partial<HeldRow>): HeldRow {
  return {
    id: "b1",
    topic: "fuel",
    title: "Diesel moved",
    headline: "Up 2%.",
    counter_move: "Fuel early.",
    takeaway: "Watch PADD 3.",
    delivery_class: "routine",
    ...partial,
  };
}

function fakeDb(rows: HeldRow[]) {
  const reheld = new Map<string, string>();
  const notified: string[] = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes("from research_briefings") && text.includes("delivery_held_until is not null")) {
      return { rows };
    }
    if (text.includes("set delivery_held_until = $2")) {
      reheld.set(String(params?.[0]), String(params?.[1]));
      return { rows: [] };
    }
    if (text.includes("set telegram_notified_at = now()")) {
      notified.push(String(params?.[0]));
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { db: { query } as unknown as Queryable, reheld, notified };
}

function notifier() {
  return { notifyOwner: vi.fn(async () => true) } as unknown as TelegramNotifier & {
    notifyOwner: ReturnType<typeof vi.fn>;
  };
}

describe("flushHeldDeliveries quiet-hours re-check (CD-5)", () => {
  it("a hold expiring at 22:00 ET does NOT flush a non-urgent briefing - it re-holds to quiet end", async () => {
    const { db, reheld, notified } = fakeDb([heldRow({ id: "routine-1" })]);
    const tg = notifier();

    const sent = await flushHeldDeliveries(db, tg, "company-1", NIGHT_ET, config);

    expect(sent).toBe(0);
    expect(tg.notifyOwner).not.toHaveBeenCalled();
    expect(notified).toEqual([]);
    expect(reheld.get("routine-1")).toBe(QUIET_END_UTC);
  });

  it("an urgent briefing still flushes inside quiet hours, alongside a re-held routine one", async () => {
    const { db, reheld, notified } = fakeDb([
      heldRow({ id: "routine-1", title: "Diesel moved" }),
      heldRow({ id: "urgent-1", title: "ELD rule final", delivery_class: "urgent" }),
    ]);
    const tg = notifier();

    const sent = await flushHeldDeliveries(db, tg, "company-1", NIGHT_ET, config);

    expect(sent).toBe(1);
    expect(tg.notifyOwner).toHaveBeenCalledTimes(1);
    const message = String(tg.notifyOwner.mock.calls[0]?.[0]);
    expect(message).toContain("ELD rule final");
    expect(message).not.toContain("Diesel moved");
    expect(notified).toEqual(["urgent-1"]);
    expect(reheld.get("routine-1")).toBe(QUIET_END_UTC);
  });

  it("outside quiet hours the flush still sends expired holds as before", async () => {
    const { db, reheld, notified } = fakeDb([heldRow({ id: "routine-1" })]);
    const tg = notifier();

    const sent = await flushHeldDeliveries(db, tg, "company-1", DAY_ET, config);

    expect(sent).toBe(1);
    expect(tg.notifyOwner).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(["routine-1"]);
    expect(reheld.size).toBe(0);
  });
});
