// Audit F-023/F-024: the one spend-cap path every bot model call goes through.
import { describe, expect, it, vi } from "vitest";
import { reserveModelSpend } from "@/services/bots/spend-guard";
import type { BotTeamStore } from "@/services/bots/store";

const store = (reserve: BotTeamStore["reserveSpend"], settle = vi.fn(async () => {})) =>
  ({ reserveSpend: reserve, settleSpend: settle }) as unknown as BotTeamStore;

describe("reserveModelSpend", () => {
  it("no store: refuses (fail closed) and says why", async () => {
    const r = await reserveModelSpend(null, "billing", "Billing", 10);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/^Billing: .*won't call the model/);
  });

  it("cap reached: refuses with the cap message", async () => {
    const r = await reserveModelSpend(store(async () => null), "abel", "Abel", 10);
    expect(!r.ok && r.message).toMatch(/spending cap for this month is reached/);
  });

  it("missing reservation function (00109 not applied): names the migrations", async () => {
    const r = await reserveModelSpend(
      store(async () => { throw new Error("Could not find the function public.reserve_bot_spend in the schema cache"); }),
      "abel", "Abel", 10,
    );
    expect(!r.ok && r.message).toContain("00109");
  });

  it("reserved: settles to the real estimate after the reply", async () => {
    const settle = vi.fn(async () => {});
    const r = await reserveModelSpend(store(async () => "res-1", settle), "abel", "Abel", 10);
    expect(r.ok).toBe(true);
    if (r.ok) await r.settle(200);
    expect(settle).toHaveBeenCalledWith("res-1", expect.any(Number));
  });
});
