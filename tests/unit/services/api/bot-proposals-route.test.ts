// Audit F-022: deciding a bot proposal is the OWNER's tap. A driver's session
// gets 403 and nothing is decided; the owner's decision records his user id.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ current: { userId: "u-owner", companyId: "company-1", role: "owner" } }));
vi.mock("@/services/auth", () => ({ getAuthContext: vi.fn(async () => auth.current) }));

const store = vi.hoisted(() => ({
  decideProposal: vi.fn(async (id: string, decision: string) => ({ id, status: decision, bot_slug: "scout", title: "Take load 12" })),
  logAudit: vi.fn(async () => undefined),
  listOpenProposals: vi.fn(async () => []),
}));
vi.mock("@/services/bots/store", () => ({ createBotTeamStore: () => store }));

import { POST } from "@/app/api/bots/proposals/route";

function post(body: unknown) {
  return POST(new NextRequest("http://x/api/bots/proposals", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({}) } as never);
}

describe("POST /api/bots/proposals", () => {
  beforeEach(() => {
    store.decideProposal.mockClear();
    store.logAudit.mockClear();
  });

  it("refuses a driver with 403 and decides nothing", async () => {
    auth.current = { userId: "u-driver", companyId: "company-1", role: "driver" };
    const res = await post({ id: "p1", decision: "approved" });
    expect(res.status).toBe(403);
    expect(store.decideProposal).not.toHaveBeenCalled();
    expect(store.logAudit).not.toHaveBeenCalled();
  });

  it("the owner decides, and the decision names his user id", async () => {
    auth.current = { userId: "u-owner", companyId: "company-1", role: "owner" };
    const res = await post({ id: "p1", decision: "denied" });
    expect(res.status).toBe(200);
    expect(store.decideProposal).toHaveBeenCalledWith("p1", "denied", "owner:u-owner");
    expect(store.logAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ userId: "u-owner" }) }));
  });
});
