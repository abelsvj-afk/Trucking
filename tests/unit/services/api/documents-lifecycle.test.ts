// Reliability Unit A documents tests (design A.7/A.8.7): RETENTION
// delete (deletion never removes the file), the Deleted view (no
// signed URLs for tombstones), safeguarded document restore, the
// cleanup-incident surface (F-038), and storeDocumentFile's checked
// compensation (a failed rollback removal is recorded, not assumed).

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({
    userId: "u1",
    companyId: "company-1",
    role: "owner",
  }),
}));

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { GET } from "@/app/api/v1/documents/route";
import { DELETE } from "@/app/api/v1/documents/[id]/route";
import { POST as RESTORE } from "@/app/api/v1/documents/[id]/restore/route";
import { GET as LIST_INCIDENTS } from "@/app/api/v1/documents/cleanup-incidents/route";
import { POST as RETRY_INCIDENT } from "@/app/api/v1/documents/cleanup-incidents/[id]/retry/route";
import { storeDocumentFile, StoreDocumentError } from "@/services/documents/store-document";

type Row = Record<string, unknown>;

interface Filter {
  kind: "eq" | "isnull" | "notnull";
  col: string;
  val?: unknown;
}

const TRUCK_ID = "11111111-1111-4111-8111-111111111111";

function makeFake(opts: {
  tables: Record<string, Row[]>;
  storageObjects?: string[];
  removeError?: unknown;
}) {
  const tables = new Map<string, Row[]>(
    Object.entries(opts.tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]),
  );
  const storageObjects = new Set(opts.storageObjects ?? []);
  const signedUrlCalls: string[] = [];
  const removedPaths: string[] = [];

  function builder(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const matches = (row: Row) =>
      filters.every((f) =>
        f.kind === "eq" ? row[f.col] === f.val : f.kind === "isnull" ? row[f.col] == null : row[f.col] != null,
      );
    const execSingle = () => {
      const rows = tables.get(table) ?? [];
      if (mode === "insert") {
        const row = { id: `new-${rows.length + 1}`, ...payload };
        rows.push(row);
        tables.set(table, rows);
        return { data: { ...row }, error: null };
      }
      if (mode === "update") {
        const matched = rows.filter(matches);
        matched.forEach((r) => Object.assign(r, payload));
        return { data: matched[0] ? { ...matched[0] } : null, error: null };
      }
      const matched = rows.filter(matches);
      return { data: matched[0] ? { ...matched[0] } : null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (obj: Row) => {
        mode = "insert";
        payload = obj;
        return b;
      },
      update: (obj: Row) => {
        mode = "update";
        payload = obj;
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ kind: "eq", col, val });
        return b;
      },
      is: (col: string, val: unknown) => {
        filters.push(val === null ? { kind: "isnull", col } : { kind: "eq", col, val });
        return b;
      },
      not: (col: string, _op: string, val: unknown) => {
        filters.push(val === null ? { kind: "notnull", col } : { kind: "eq", col, val });
        return b;
      },
      order: () => b,
      textSearch: () => b,
      single: async () => execSingle(),
      maybeSingle: async () => execSingle(),
      then: (resolve: (v: unknown) => void) => {
        const rows = tables.get(table) ?? [];
        if (mode === "update") {
          const matched = rows.filter(matches);
          matched.forEach((r) => Object.assign(r, payload));
          resolve({ data: matched.map((r) => ({ ...r })), error: null });
          return;
        }
        if (mode === "insert") {
          resolve(execSingle());
          return;
        }
        const matched = rows.filter(matches);
        resolve({ data: matched.map((r) => ({ ...r })), error: null });
      },
    };
    return b;
  }

  const client = {
    from: (table: string) => builder(table),
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => {
          signedUrlCalls.push(path);
          return { data: { signedUrl: `https://signed/${path}` }, error: null };
        },
        remove: async (paths: string[]) => {
          if (opts.removeError) return { data: null, error: opts.removeError };
          paths.forEach((p) => {
            removedPaths.push(p);
            storageObjects.delete(p);
          });
          return { data: paths.map((name) => ({ name })), error: null };
        },
        list: async (folder: string, listOpts?: { search?: string }) => {
          const names = [...storageObjects]
            .filter((p) => p.startsWith(folder ? `${folder}/` : ""))
            .map((p) => ({ name: p.slice(folder ? folder.length + 1 : 0) }))
            .filter((o) => !listOpts?.search || o.name.includes(listOpts.search));
          return { data: names, error: null };
        },
        upload: async () => ({ error: null }),
      }),
    },
  };

  return { client, tables, storageObjects, signedUrlCalls, removedPaths };
}

function useFake(opts: Parameters<typeof makeFake>[0]) {
  const fake = makeFake(opts);
  vi.mocked(createClient).mockResolvedValue(fake.client as never);
  return fake;
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

const liveDoc = {
  id: "doc-1",
  company_id: "company-1",
  related_entity_type: "truck",
  related_entity_id: TRUCK_ID,
  file_name: "bol.pdf",
  storage_path: "company-1/uuid-bol.pdf",
  scan_storage_path: null,
  uploaded_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  retention_status: null,
};

const liveTruck = { id: TRUCK_ID, company_id: "company-1", deleted_at: null };

describe("retention delete (F-007 / A.8.7)", () => {
  it("DELETE tombstones the row with retention_status='retained' and NEVER removes the file; a second DELETE is 404", async () => {
    const fake = useFake({
      tables: { documents: [liveDoc], trucks: [liveTruck] },
      storageObjects: ["company-1/uuid-bol.pdf"],
    });

    const res = await DELETE(new NextRequest("http://x/api/v1/documents/doc-1", { method: "DELETE" }), ctxFor("doc-1"));
    expect(res.status).toBe(204);

    const row = fake.tables.get("documents")![0]!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.retention_status).toBe("retained");
    // The file is still in storage - deletion removed nothing.
    expect(fake.removedPaths).toEqual([]);
    expect(fake.storageObjects.has("company-1/uuid-bol.pdf")).toBe(true);

    const again = await DELETE(new NextRequest("http://x/api/v1/documents/doc-1", { method: "DELETE" }), ctxFor("doc-1"));
    expect(again.status).toBe(404);
  });

  it("the default list excludes tombstones (and signs the live ones); ?deleted=only shows tombstones WITHOUT signed URLs", async () => {
    const tombstone = {
      ...liveDoc,
      id: "doc-2",
      file_name: "old.pdf",
      storage_path: "company-1/uuid-old.pdf",
      deleted_at: "2026-01-03T00:00:00Z",
      retention_status: "retained",
    };
    const fake = useFake({
      tables: { documents: [liveDoc, tombstone], trucks: [liveTruck] },
      storageObjects: ["company-1/uuid-bol.pdf", "company-1/uuid-old.pdf"],
    });

    const list = await (
      await GET(new NextRequest(`http://x/api/v1/documents?related_entity_type=truck&related_entity_id=${TRUCK_ID}`))
    ).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe("doc-1");
    expect(list.data[0].signed_url).toContain("https://signed/");

    fake.signedUrlCalls.length = 0;
    const deleted = await (
      await GET(
        new NextRequest(
          `http://x/api/v1/documents?related_entity_type=truck&related_entity_id=${TRUCK_ID}&deleted=only`,
        ),
      )
    ).json();
    expect(deleted.data).toHaveLength(1);
    expect(deleted.data[0].id).toBe("doc-2");
    expect(deleted.data[0].retention_status).toBe("retained");
    expect(deleted.data[0].signed_url).toBeNull();
    expect(fake.signedUrlCalls).toEqual([]);
  });

  it("restore clears the tombstone when the parent is live, and refuses with a named 422 when the parent was deleted", async () => {
    const tombstone = {
      ...liveDoc,
      deleted_at: "2026-01-03T00:00:00Z",
      retention_status: "retained",
    };
    const fake = useFake({
      tables: { documents: [tombstone], trucks: [{ ...liveTruck, deleted_at: "2026-01-02T00:00:00Z" }] },
    });

    const refused = await RESTORE(
      new NextRequest("http://x/api/v1/documents/doc-1/restore", { method: "POST" }),
      ctxFor("doc-1"),
    );
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.message).toContain("truck");
    expect(fake.tables.get("documents")![0]!.deleted_at).not.toBeNull();

    fake.tables.get("trucks")![0]!.deleted_at = null;
    const restored = await RESTORE(
      new NextRequest("http://x/api/v1/documents/doc-1/restore", { method: "POST" }),
      ctxFor("doc-1"),
    );
    expect(restored.status).toBe(200);
    const row = fake.tables.get("documents")![0]!;
    expect(row.deleted_at).toBeNull();
    expect(row.retention_status).toBeNull();
  });
});

describe("cleanup incidents (F-038 surface)", () => {
  const incident = {
    id: "inc-1",
    company_id: "company-1",
    storage_path: "company-1/uuid-orphan.pdf",
    kind: "row_insert_failed",
    status: "open",
    detail: "insert failed",
    created_at: "2026-01-01T00:00:00Z",
    resolved_at: null,
  };

  it("GET lists open incidents only", async () => {
    useFake({
      tables: {
        cleanup_incidents: [incident, { ...incident, id: "inc-2", status: "resolved" }],
        documents: [],
      },
    });
    const res = await LIST_INCIDENTS(new NextRequest("http://x/api/v1/documents/cleanup-incidents"));
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("inc-1");
  });

  it("retry closes as object_absent when the object is already gone", async () => {
    const fake = useFake({ tables: { cleanup_incidents: [incident], documents: [] }, storageObjects: [] });
    const res = await RETRY_INCIDENT(
      new NextRequest("http://x/api/v1/documents/cleanup-incidents/inc-1/retry", { method: "POST" }),
      ctxFor("inc-1"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("object_absent");
    expect(fake.tables.get("cleanup_incidents")![0]!.resolved_at).not.toBeNull();
  });

  it("retry removes a present object and closes as resolved", async () => {
    const fake = useFake({
      tables: { cleanup_incidents: [incident], documents: [] },
      storageObjects: ["company-1/uuid-orphan.pdf"],
    });
    const res = await RETRY_INCIDENT(
      new NextRequest("http://x/api/v1/documents/cleanup-incidents/inc-1/retry", { method: "POST" }),
      ctxFor("inc-1"),
    );
    expect((await res.json()).status).toBe("resolved");
    expect(fake.storageObjects.has("company-1/uuid-orphan.pdf")).toBe(false);
  });

  it("a failed removal leaves the incident OPEN with the failure recorded", async () => {
    const fake = useFake({
      tables: { cleanup_incidents: [incident], documents: [] },
      storageObjects: ["company-1/uuid-orphan.pdf"],
      removeError: { message: "storage unavailable" },
    });
    const res = await RETRY_INCIDENT(
      new NextRequest("http://x/api/v1/documents/cleanup-incidents/inc-1/retry", { method: "POST" }),
      ctxFor("inc-1"),
    );
    const body = await res.json();
    expect(body.status).toBe("open");
    expect(String(body.detail)).toContain("storage unavailable");
    expect(fake.tables.get("cleanup_incidents")![0]!.status).toBe("open");
  });
});

describe("storeDocumentFile compensation (F-038 record)", () => {
  function storeFake(removeResult: { data: unknown; error: unknown }) {
    const incidentInserts: Row[] = [];
    const client = {
      storage: {
        from: () => ({
          upload: vi.fn().mockResolvedValue({ error: null }),
          remove: vi.fn().mockResolvedValue(removeResult),
        }),
      },
      from: (table: string) => ({
        insert: (obj: Row) => {
          if (table === "cleanup_incidents") {
            incidentInserts.push(obj);
            return Promise.resolve({ error: null });
          }
          return {
            select: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "db down" } }),
            }),
          };
        },
      }),
    } as unknown as SupabaseClient;
    return { client, incidentInserts };
  }

  const input = {
    companyId: "company-1",
    relatedEntityType: "truck",
    relatedEntityId: TRUCK_ID,
    fileName: "bol.pdf",
    body: new Blob([new Uint8Array([1])], { type: "application/pdf" }),
    contentType: "application/pdf",
    size: 1,
  };

  it("when the rollback removal confirms the object is gone, no incident is recorded", async () => {
    const { client, incidentInserts } = storeFake({ data: [{ name: "x" }], error: null });
    await expect(storeDocumentFile(client, input)).rejects.toMatchObject({
      name: "StoreDocumentError",
      kind: "insert_failed",
    });
    expect(incidentInserts).toEqual([]);
  });

  it("when the rollback removal does NOT confirm removal, an incident is recorded and the error says cleanup may have failed", async () => {
    const { client, incidentInserts } = storeFake({ data: [], error: null });
    const err = await storeDocumentFile(client, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreDocumentError);
    expect((err as StoreDocumentError).kind).toBe("insert_failed");
    expect((err as Error).message).toContain("could not be cleaned up");
    expect(incidentInserts).toHaveLength(1);
    expect(String(incidentInserts[0]!.storage_path)).toContain("company-1/");
    expect(incidentInserts[0]!.kind).toBe("row_insert_failed");
  });
});
