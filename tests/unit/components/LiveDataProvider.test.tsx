// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type StatusCb = (status: string) => void;
type ChangeCb = (payload: unknown) => void;
const handlers: { table: string; cb: ChangeCb }[] = [];
let statusCb: StatusCb | null = null;
const setAuth = vi.fn();
const removeChannel = vi.fn();
let session: { access_token: string } | null = { access_token: "tok-1" };
let createThrows = false;

vi.mock("@/services/db/client", () => ({
  createClient: () => {
    if (createThrows) throw new Error("no config");
    const channel = {
      on: (_kind: string, filter: { table: string }, cb: ChangeCb) => {
        handlers.push({ table: filter.table, cb });
        return channel;
      },
      subscribe: (cb: StatusCb) => {
        statusCb = cb;
        return channel;
      },
    };
    return {
      auth: { getSession: () => Promise.resolve({ data: { session } }) },
      realtime: { setAuth },
      channel: () => channel,
      removeChannel,
    };
  },
}));

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiClient: { list: vi.fn() },
  };
});

import { apiClient, MUTATION_EVENT } from "@/lib/api-client";
import LiveDataProvider, { LIVE_THROTTLE_MS } from "@/components/live/LiveDataProvider";
import LiveIndicator from "@/components/live/LiveIndicator";
import { useApiList } from "@/lib/use-api-list";
import { LIVE_TABLES } from "@/lib/live-tables";

function DutyList() {
  const { state } = useApiList<{ id: string }>("duty-logs");
  return <p>{state.status === "loaded" ? `rows:${state.result.data.length}` : state.status}</p>;
}

async function mount() {
  render(
    <LiveDataProvider>
      <LiveIndicator />
      <DutyList />
    </LiveDataProvider>,
  );
  await act(async () => {});
}

const fire = (table: string) => handlers.filter((h) => h.table === table).forEach((h) => h.cb({ new: { secret: "x" } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  handlers.length = 0;
  statusCb = null;
  session = { access_token: "tok-1" };
  createThrows = false;
  vi.mocked(apiClient.list).mockResolvedValue({ data: [{ id: "a" }], page: { limit: 50, offset: 0, total: 1 } });
});

describe("LiveDataProvider", () => {
  it("subscribes every live table with the session token, and shows Live only once subscribed", async () => {
    await mount();
    expect(setAuth).toHaveBeenCalledWith("tok-1");
    expect(new Set(handlers.map((h) => h.table))).toEqual(new Set(LIVE_TABLES));
    expect(screen.queryByText("Live")).toBeNull();
    await act(async () => statusCb!("SUBSCRIBED"));
    expect(screen.getByText("Live")).toBeTruthy();
    await act(async () => statusCb!("CHANNEL_ERROR"));
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("never subscribes without a signed-in session (no anonymous 'Live')", async () => {
    session = null;
    await mount();
    expect(handlers).toHaveLength(0);
    expect(setAuth).not.toHaveBeenCalled();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("a burst of change events becomes one throttled re-fetch, without a loading flash", async () => {
    await mount();
    expect(apiClient.list).toHaveBeenCalledTimes(1);
    act(() => {
      for (let i = 0; i < 5; i++) fire("duty_logs");
    });
    expect(apiClient.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_THROTTLE_MS);
    });
    expect(apiClient.list).toHaveBeenCalledTimes(2);
    expect(screen.getByText("rows:1")).toBeTruthy();
  });

  it("a change to another table does not re-fetch this list", async () => {
    await mount();
    act(() => fire("loads"));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_THROTTLE_MS);
    });
    expect(apiClient.list).toHaveBeenCalledTimes(1);
  });

  it("a write made in this tab refreshes at once", async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(MUTATION_EVENT, { detail: { path: "/api/v1/duty-logs/abc" } }));
    });
    expect(apiClient.list).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when the page becomes visible again (safety net)", async () => {
    await mount();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(apiClient.list).toHaveBeenCalledTimes(2);
  });

  it("works without browser config - just not live", async () => {
    createThrows = true;
    await mount();
    expect(screen.getByText("rows:1")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("removes its channel on unmount", async () => {
    await mount();
    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });
});

describe("migration 00058", () => {
  it("adds exactly the tables the app listens to", () => {
    const sql = readFileSync("supabase/migrations/00058_realtime_live_layer.sql", "utf8");
    const listed = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((t) => t !== "supabase_realtime" && t !== "public");
    expect(new Set(listed)).toEqual(new Set(LIVE_TABLES));
  });
});
