// Authority-matrix gaps G1/G2: the position endpoint honors the live_location
// switch (default on, explicit off stops it) and the news-image endpoint
// refuses to fetch anything when deep_research is off.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ userId: "u1", companyId: "company-1", role: "owner" }),
}));
const loadNewsImage = vi.fn();
vi.mock("@/services/research/news-image", () => ({ loadNewsImage: (...a: unknown[]) => loadNewsImage(...a) }));
vi.mock("@/services/db/server", () => ({ createClient: vi.fn() }));
import { createClient } from "@/services/db/server";

function db(opts: { globallyDisabled?: boolean; capRow?: { enabled: boolean } | null; position?: Record<string, unknown> | null }) {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order"]) q[m] = () => q;
      // The position route now takes the newest of both feeds: .order().limit(1) -> rows.
      q.limit = async () => ({ data: opts.position ? [opts.position] : [], error: null });
      q.single = async () => ({ data: { ai_globally_disabled: opts.globallyDisabled ?? false }, error: null });
      q.maybeSingle = async () =>
        table === "ai_capability_settings"
          ? { data: opts.capRow ?? null, error: null }
          : { data: opts.position ?? null, error: null };
      return q;
    },
  };
}

import { GET as getPosition } from "@/app/api/v1/position/route";
import { GET as getNewsImage } from "@/app/api/v1/news-image/route";

const POS = { lat: 28, lng: -81, accuracy_m: 5, heading_deg: null, speed_mph: 0, recorded_at: new Date().toISOString() };
const SIGNAL = "11111111-1111-4111-8111-111111111111";

beforeEach(() => loadNewsImage.mockReset());

describe("GET /api/v1/position and the live_location switch", () => {
  const call = async () => (await getPosition(new NextRequest("http://x/api/v1/position"))).json();
  it("no switch row = on (opt-in by sharing)", async () => {
    vi.mocked(createClient).mockResolvedValue(db({ position: POS }) as never);
    expect((await call()).position).toMatchObject({ lat: 28 });
  });
  it("an explicit off row, or the global switch, returns no position", async () => {
    vi.mocked(createClient).mockResolvedValue(db({ position: POS, capRow: { enabled: false } }) as never);
    expect((await call()).position).toBeNull();
    vi.mocked(createClient).mockResolvedValue(db({ position: POS, globallyDisabled: true }) as never);
    expect((await call()).position).toBeNull();
  });
});

describe("GET /api/v1/news-image and the deep_research switch", () => {
  const call = () => getNewsImage(new NextRequest(`http://x/api/v1/news-image?signal=${SIGNAL}&i=0`));
  it("deep_research off (or no row): 404 and nothing is fetched", async () => {
    vi.mocked(createClient).mockResolvedValue(db({ capRow: null }) as never);
    expect((await call()).status).toBe(404);
    vi.mocked(createClient).mockResolvedValue(db({ capRow: { enabled: false } }) as never);
    expect((await call()).status).toBe(404);
    expect(loadNewsImage).not.toHaveBeenCalled();
  });
  it("deep_research on: the image service runs", async () => {
    vi.mocked(createClient).mockResolvedValue(db({ capRow: { enabled: true } }) as never);
    loadNewsImage.mockResolvedValue({ ok: true, bytes: Buffer.from("x"), contentType: "image/jpeg" });
    expect((await call()).status).toBe(200);
    expect(loadNewsImage).toHaveBeenCalledTimes(1);
  });
});
