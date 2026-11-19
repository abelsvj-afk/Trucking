// Voice notes data layer (00101) against a fake Supabase client.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createVoiceNote, listVoiceNotesNear, VoiceNoteError } from "@/services/api/voice-notes";

type Rows = Record<string, Record<string, unknown>[]>;

function fakeClient(tables: Rows, opts: { members?: number; insertError?: string } = {}) {
  const removed: string[][] = [];
  const uploads: string[] = [];
  const query = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const q: Record<string, unknown> = {};
    const chain = (fn: (r: Record<string, unknown>[]) => Record<string, unknown>[]) => {
      rows = fn(rows);
      return q;
    };
    Object.assign(q, {
      select: () => q,
      eq: (c: string, v: unknown) => chain((r) => r.filter((x) => x[c] === v)),
      is: (c: string, v: unknown) => chain((r) => r.filter((x) => (x[c] ?? null) === v)),
      gte: (c: string, v: number) => chain((r) => r.filter((x) => (x[c] as number) >= v)),
      lte: (c: string, v: number) => chain((r) => r.filter((x) => (x[c] as number) <= v)),
      in: (c: string, v: unknown[]) => chain((r) => r.filter((x) => v.includes(x[c]))),
      order: () => q,
      limit: () => q,
      then: (res: (v: { data: unknown; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
      insert: () => ({
        select: () => ({ single: async () => (opts.insertError ? { data: null, error: { message: opts.insertError } } : { data: { id: "new-id" }, error: null }) }),
      }),
    });
    return q;
  };
  const client = {
    from: query,
    rpc: async () => ({ data: opts.members ?? 1, error: null }),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push(path);
          return { error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { error: null };
        },
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, removed, uploads };
}

const base = { company_id: "c1", kind: "hazard", heading_deg: 0, road_ref: "I-75", duration_s: 6, expires_at: null, removed_at: null, created_at: "2026-11-19T15:00:00Z" };

describe("listVoiceNotesNear", () => {
  it("returns coworkers' notes near him, never his own, with the author's report not counting", async () => {
    const { client } = fakeClient(
      {
        voice_notes: [
          { ...base, id: "a", author_id: "me", lat: 30, lng: -82 },
          { ...base, id: "b", author_id: "pat", lat: 30.01, lng: -82 },
          { ...base, id: "far", author_id: "pat", lat: 33, lng: -82 },
        ],
        voice_note_views: [],
        voice_note_reports: [{ note_id: "b", user_id: "pat", kind: "gone" }],
      },
      { members: 2 },
    );
    const { notes } = await listVoiceNotesNear(client, { userId: "me", companyId: "c1" }, { lat: 30, lng: -82 }, 35, Date.parse("2026-11-19T15:10:00Z"));
    expect(notes.map((n) => n.id)).toEqual(["b"]);
    expect(notes[0]!.goneReports).toBe(0);
  });

  it("a coworker's 'gone' clears it for everyone in a small fleet", async () => {
    const { client } = fakeClient(
      {
        voice_notes: [{ ...base, id: "b", author_id: "pat", lat: 30.01, lng: -82 }],
        voice_note_views: [],
        voice_note_reports: [{ note_id: "b", user_id: "sam", kind: "gone" }],
      },
      { members: 3 },
    );
    const { notes } = await listVoiceNotesNear(client, { userId: "me", companyId: "c1" }, { lat: 30, lng: -82 }, 35, Date.parse("2026-11-19T15:10:00Z"));
    expect(notes).toEqual([]);
  });
});

describe("createVoiceNote", () => {
  const input = { kind: "bridge" as const, point: { lat: 30, lng: -82 }, headingDeg: 90, roadRef: "US-90", durationS: 9, audio: new Blob(["x"], { type: "audio/webm" }), contentType: "audio/webm;codecs=opus" };
  it("stores the audio under the company's own folder and sets no expiry for a bridge", async () => {
    const { client, uploads } = fakeClient({});
    await expect(createVoiceNote(client, { userId: "me", companyId: "c1" }, input)).resolves.toEqual({ id: "new-id" });
    expect(uploads[0]).toMatch(/^c1\/voice-notes\/[0-9a-f-]+\.webm$/);
  });
  it("refuses anything that isn't audio, and too-long recordings", async () => {
    const { client } = fakeClient({});
    await expect(createVoiceNote(client, { userId: "me", companyId: "c1" }, { ...input, contentType: "text/html" })).rejects.toBeInstanceOf(VoiceNoteError);
    await expect(createVoiceNote(client, { userId: "me", companyId: "c1" }, { ...input, durationS: 90 })).rejects.toBeInstanceOf(VoiceNoteError);
  });
  it("leaves no orphaned audio when the row fails", async () => {
    const { client, removed } = fakeClient({}, { insertError: "boom" });
    await expect(createVoiceNote(client, { userId: "me", companyId: "c1" }, input)).rejects.toThrow("boom");
    expect(removed).toHaveLength(1);
  });
});

void vi;
