import { describe, expect, it, vi } from "vitest";
import { recordingClient, unscopedQueries } from "../../../helpers/recording-client";
import { buildGameSnapshot } from "@/services/game/snapshot";
import { metricActualForMonth, closeMonthlyCheckpoint } from "@/services/game/checkpoint";
import { countReGamesToday, isGamePlanEnabled, loadActiveTarget, loadPersistentOverrides } from "@/services/game/run-game-plan";

// Wave 4 matrix §3 item 2: the game scheduler runs with the SERVICE ROLE. Every query its helpers issue
// must carry the configured company. (Query-level proof - see tests/helpers/recording-client.ts.)
const A = "00000000-0000-0000-0000-00000000aaaa";

describe("game services are scoped to the configured company (service role)", () => {
  it("snapshot, checkpoint and run-game-plan helpers scope every query", async () => {
    const { client, queries } = recordingClient();
    const c = client as never;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const attempts: (() => Promise<unknown>)[] = [
      () => buildGameSnapshot(c, A, "2026-11-05"),
      () => metricActualForMonth(c, A, "revenue" as never, "2026-10"),
      () => metricActualForMonth(c, A, "net" as never, "2026-10"),
      () => isGamePlanEnabled(c, A),
      () => loadActiveTarget(c, A),
      () => loadPersistentOverrides(c, A),
      () => countReGamesToday(c, A),
      () => closeMonthlyCheckpoint({ client: c, companyId: A, notifier: null, now: new Date("2026-11-05T12:00:00Z") }),
    ];
    for (const run of attempts) {
      try {
        await run();
      } catch {
        // shape errors on empty fake data are fine; the queries reached are what matter
      }
    }
    spy.mockRestore();

    expect(queries.filter((q) => q.calls.length > 0).length).toBeGreaterThan(8);
    expect(unscopedQueries(queries, A), "game queries not scoped to the configured company").toEqual([]);
  });
});
