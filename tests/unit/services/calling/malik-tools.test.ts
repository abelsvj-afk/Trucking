// Malik real tools (docs/design/malik-real-tools.md). The live
// Telnyx API and the live database are never hit: the Supabase client
// is an in-memory fake, and the route test signs with a throwaway
// in-test Ed25519 keypair (same pattern as telnyx.test.ts).
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  formatHosSnapshot,
  isMalikToolName,
  MALIK_TOOL_NAMES,
  recordMalikCallReport,
  runMalikTool,
  type MalikToolName,
} from "@/services/calling/malik-tools";

const COMPANY = "75efa4a5-a126-467d-b82a-c32a12628dba";

type Row = Record<string, unknown>;
let idCounter = 0;

interface FakeOpts {
  failSelect?: string[];
}

/** In-memory fake client: only the query shapes the Malik paths use. */
function makeClient(db: Record<string, Row[]>, opts: FakeOpts = {}) {
  const from = (table: string) => {
    const failing = opts.failSelect?.includes(table) ?? false;
    return {
      select: () => {
        let view = [...(db[table] ?? [])];
        const builder = {
          eq: (col: string, v: unknown) => {
            view = view.filter((r) => r[col] === v);
            return builder;
          },
          is: (col: string, v: unknown) => {
            view = view.filter((r) => r[col] === v);
            return builder;
          },
          order: (col: string, o: { ascending: boolean }) => {
            view = [...view].sort((a, b) =>
              String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (o.ascending ? 1 : -1),
            );
            return builder;
          },
          limit: (n: number) => {
            view = view.slice(0, n);
            return builder;
          },
          maybeSingle: async () => {
            if (failing) throw new Error("db down");
            return { data: view[0] ?? null, error: null };
          },
          single: async () => {
            if (failing) throw new Error("db down");
            return view[0] ? { data: view[0], error: null } : { data: null, error: { message: "No rows" } };
          },
          then: (resolve: (v: unknown) => void) => {
            if (failing) throw new Error("db down");
            resolve({ data: view, error: null });
          },
        };
        return builder;
      },
      insert: (row: Row) => {
        const inserted = { ...row, id: row.id ?? `fake-${++idCounter}` };
        (db[table] ??= []).push(inserted);
        return {
          select: () => ({ single: async () => ({ data: inserted, error: null }) }),
          then: (resolve: (v: unknown) => void) => resolve({ data: inserted, error: null }),
        };
      },
      update: (patch: Row) => ({
        eq: (col: string, v: unknown) => {
          (db[table] ?? []).filter((r) => r[col] === v).forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ error: null, data: null });
        },
      }),
    };
  };
  return { from } as unknown as SupabaseClient;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawB64 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

const holder = vi.hoisted(() => ({ client: null as unknown as SupabaseClient }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => holder.client,
}));

import { POST } from "@/app/api/telnyx/malik-tools/[companyId]/[tool]/route";

function signedRequest(tool: MalikToolName, body: Record<string, unknown>, companyId = COMPANY): NextRequest {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]),
    privateKey,
  ).toString("base64");
  return new NextRequest(`http://localhost/api/telnyx/malik-tools/${companyId}/${tool}`, {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": signature,
      "telnyx-timestamp": timestamp,
    },
  });
}

describe("Malik tool allowlist", () => {
  it("has exactly the six tools, and nothing else", () => {
    expect([...MALIK_TOOL_NAMES]).toEqual([
      "malik_get_active_load",
      "malik_get_delivery_eta",
      "malik_get_hos_hours",
      "malik_get_trip_status",
      "malik_get_load_paperwork",
      "malik_take_message",
    ]);
    expect(isMalikToolName("place_call")).toBe(false);
    expect(isMalikToolName("list_loads")).toBe(false);
    expect(isMalikToolName("create_load")).toBe(false);
    expect(isMalikToolName("malik_take_message")).toBe(true);
  });
});

describe("runMalikTool", () => {
  it("says plainly when there is no active load, and logs the call", async () => {
    const toolCalls: Row[] = [];
    const db: Record<string, Row[]> = { loads: [], malik_tool_calls: toolCalls };
    const client = makeClient(db);
    const result = await runMalikTool(client, COMPANY, "malik_get_active_load", {});
    expect(result).toContain("No active load");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.tool_name).toBe("malik_get_active_load");
  });

  it("says plainly when a trip number is not on file", async () => {
    const client = makeClient({ loads: [], malik_tool_calls: [] });
    const result = await runMalikTool(client, COMPANY, "malik_get_active_load", { trip_number: "9999" });
    expect(result).toContain("No load with trip number 9999");
  });

  it("returns the load's lane, rate, and broker for a trip number", async () => {
    const db: Record<string, Row[]> = {
      loads: [
        {
          id: "load-1",
          company_id: COMPANY,
          trip_number: "1874",
          origin: "Panama City, FL",
          destination: "Seminole, OK",
          status: "confirmed",
          pickup_date: "2026-11-10",
          delivery_date: "2026-11-12",
          pickup_window_start: null,
          pickup_window_end: null,
          delivery_window_start: null,
          delivery_window_end: null,
          pickup_tz: null,
          delivery_tz: null,
          rate_cents: 61120,
          miles: 1111.27,
          broker_id: "broker-1",
          deleted_at: null,
        },
      ],
      brokers: [{ id: "broker-1", company_id: COMPANY, name: "ITS Logistics LLC" }],
      malik_tool_calls: [],
    };
    const client = makeClient(db);
    const result = await runMalikTool(client, COMPANY, "malik_get_active_load", { trip_number: "1874" });
    expect(result).toContain("Trip 1874: Panama City, FL → Seminole, OK (confirmed).");
    expect(result).toContain("ITS Logistics LLC");
    expect(result).toContain("$611.20");
  });

  it("rejects a message with no caller name and says so honestly", async () => {
    const reports: Row[] = [];
    const toolCalls: Row[] = [];
    const db: Record<string, Row[]> = { malik_call_reports: reports, malik_tool_calls: toolCalls };
    const client = makeClient(db);
    const result = await runMalikTool(client, COMPANY, "malik_take_message", { message: "call me" });
    expect(result).toContain("missing something");
    expect(reports).toHaveLength(0);
    expect(String(toolCalls[0]?.result_text)).toContain("ARGUMENTS REJECTED");
  });

  it("rejects a paperwork lookup with a bad load id before any read", async () => {
    const client = makeClient({ malik_tool_calls: [] });
    const result = await runMalikTool(client, COMPANY, "malik_get_load_paperwork", { load_id: "not-a-uuid" });
    expect(result).toContain("missing something");
  });

  it("records a message and says it will pass it to Abel", async () => {
    const reports: Row[] = [];
    const toolCalls: Row[] = [];
    const db: Record<string, Row[]> = { malik_call_reports: reports, malik_tool_calls: toolCalls };
    const client = makeClient(db);
    const result = await runMalikTool(client, COMPANY, "malik_take_message", {
      caller_name: "Marcus",
      callback_number: "+15551234567",
      message: "The dock is running two hours late.",
      load_ref: "1874",
    });
    expect(result).toContain("pass that to Abel");
    expect(result).toContain("Marcus");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe("message");
    expect(reports[0]?.title).toContain("Marcus");
  });

  it("never invents an answer when the records fail", async () => {
    const client = makeClient({ malik_tool_calls: [] }, { failSelect: ["loads"] });
    const result = await runMalikTool(client, COMPANY, "malik_get_active_load", {});
    expect(result).toContain("couldn't read that right now");
    expect(result).not.toContain("Trip");
  });
});

describe("formatHosSnapshot", () => {
  it("reads in the same words as Abel's hos_summary", () => {
    const snapshot = {
      rows: [{ duty_status: "driving", started_at: "2026-11-19T14:00:00Z" }],
      short: {
        drivingMinutesInWindow: 300,
        windowElapsedMinutes: 480,
        drivingMinutesSinceBreak: 120,
        warnings: [],
      },
      cycle: {
        cycle: "70/8",
        periodAnchor: "midnight",
        carrierTimeZone: "America/New_York",
        cycleLimitMinutes: 4200,
        onDutyMinutesInCycle: 1800,
        restartApplied: null,
        restartUnverified: false,
        warnings: [],
      },
      provisional: true,
    };
    const text = formatHosSnapshot(snapshot as never);
    expect(text).toContain("Current duty status: driving");
    expect(text).toContain("Driving in current 14h window: 5h 00m of 11h.");
    expect(text).toContain("70/8 cycle");
  });
});

describe("recordMalikCallReport", () => {
  it("keeps one row per conversation, updating it instead of duplicating", async () => {
    const reports: Row[] = [];
    const db: Record<string, Row[]> = { malik_call_reports: reports };
    const client = makeClient(db);
    const first = await recordMalikCallReport(
      client,
      COMPANY,
      {
        kind: "call-summary",
        telnyxConversationId: "conv-1",
        title: "Call on the company line",
        body: "Call ended — waiting for the transcript.",
        payload: {},
      },
      { postToGroup: false },
    );
    const second = await recordMalikCallReport(
      client,
      COMPANY,
      {
        kind: "call-summary",
        telnyxConversationId: "conv-1",
        title: "Call on the company line",
        body: "Summary: broker asked for the ETA.\n\nTranscript:\nHello.",
        payload: { summary: "broker asked for the ETA" },
      },
      { postToGroup: false },
    );
    expect(reports).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect(reports[0]?.body).toContain("broker asked for the ETA");
  });
});

describe("POST /api/telnyx/malik-tools/[companyId]/[tool]", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["TELNYX_PUBLIC_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      envBackup[key] = process.env[key];
    }
    process.env.TELNYX_PUBLIC_KEY = rawB64;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("503s when the public key is not configured (fail closed)", async () => {
    delete process.env.TELNYX_PUBLIC_KEY;
    const res = await POST(signedRequest("malik_get_active_load", {}), {
      params: Promise.resolve({ companyId: COMPANY, tool: "malik_get_active_load" }),
    });
    expect(res.status).toBe(503);
  });

  it("401s on a bad signature", async () => {
    const req = signedRequest("malik_get_active_load", {});
    req.headers.set("telnyx-signature-ed25519", Buffer.alloc(64).toString("base64"));
    const res = await POST(req, {
      params: Promise.resolve({ companyId: COMPANY, tool: "malik_get_active_load" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s on bad JSON", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "{not json";
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]),
      privateKey,
    ).toString("base64");
    const req = new NextRequest(`http://localhost/api/telnyx/malik-tools/${COMPANY}/malik_get_active_load`, {
      method: "POST",
      body: rawBody,
      headers: {
        "telnyx-signature-ed25519": signature,
        "telnyx-timestamp": timestamp,
      },
    });
    const res = await POST(req, {
      params: Promise.resolve({ companyId: COMPANY, tool: "malik_get_active_load" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s on an unknown tool name", async () => {
    const res = await POST(signedRequest("malik_get_active_load", {}), {
      params: Promise.resolve({ companyId: COMPANY, tool: "place_call" }),
    });
    expect(res.status).toBe(404);
  });

  it("404s on a non-UUID company id", async () => {
    const res = await POST(signedRequest("malik_get_active_load", {}, "not-a-company"), {
      params: Promise.resolve({ companyId: "not-a-company", tool: "malik_get_active_load" }),
    });
    expect(res.status).toBe(404);
  });

  it("200s with the grounding text for a signed call", async () => {
    const db: Record<string, Row[]> = {
      companies: [{ id: COMPANY }],
      loads: [],
      malik_tool_calls: [],
    };
    holder.client = makeClient(db);
    const res = await POST(signedRequest("malik_get_active_load", {}), {
      params: Promise.resolve({ companyId: COMPANY, tool: "malik_get_active_load" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string };
    expect(body.result).toContain("No active load");
    expect(db.malik_tool_calls).toHaveLength(1);
  });
});
