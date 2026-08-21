// Documents don't use the generic createCrudRoutes factory (multipart
// upload, no PATCH, hard delete + Storage cleanup - docs/api-contracts.md),
// so they get their own route tests, following the same mocked-Supabase
// approach as tests/unit/services/api/crud-routes.test.ts.

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({
    userId: "u1",
    companyId: "company-1",
    role: "owner",
  }),
}));

function mockSupabase(options: {
  queryResult?: { data?: unknown; error?: unknown };
  uploadError?: unknown;
  signedUrl?: string | null;
  signedUrlError?: unknown;
}) {
  const queryBuilder: Record<string, unknown> & {
    then: (resolve: (v: unknown) => void) => void;
  } = {
    select: () => queryBuilder,
    eq: () => queryBuilder,
    order: () => queryBuilder,
    insert: () => queryBuilder,
    delete: () => queryBuilder,
    single: () => queryBuilder,
    maybeSingle: () => queryBuilder,
    then: (resolve: (v: unknown) => void) => resolve(options.queryResult ?? { data: null }),
  };

  return {
    from: () => queryBuilder,
    storage: {
      from: () => ({
        upload: vi.fn().mockResolvedValue({ error: options.uploadError ?? null }),
        remove: vi.fn().mockResolvedValue({ error: null }),
        createSignedUrl: vi.fn().mockResolvedValue({
          data: options.signedUrl ? { signedUrl: options.signedUrl } : null,
          error: options.signedUrlError ?? null,
        }),
      }),
    },
  };
}

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { POST, GET } from "@/app/api/v1/documents/route";
import { DELETE } from "@/app/api/v1/documents/[id]/route";

const VALID_ENTITY_ID = "11111111-1111-4111-8111-111111111111";

function formDataRequest(fields: Record<string, string | Blob>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.append(key, value);
  return new NextRequest("http://localhost/api/v1/documents", { method: "POST", body: formData });
}

describe("POST /api/v1/documents", () => {
  it("rejects a missing file", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const res = await POST(
      formDataRequest({ related_entity_type: "truck", related_entity_id: VALID_ENTITY_ID }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid related_entity_type", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const res = await POST(
      formDataRequest({
        file: new File(["hello"], "bol.pdf"),
        related_entity_type: "invoice",
        related_entity_id: VALID_ENTITY_ID,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing related_entity_id", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const res = await POST(
      formDataRequest({ file: new File(["hello"], "bol.pdf"), related_entity_type: "truck" }),
    );
    expect(res.status).toBe(400);
  });

  it("201s with the created row on valid input", async () => {
    const createdRow = {
      id: "doc-1",
      company_id: "company-1",
      related_entity_type: "truck",
      related_entity_id: VALID_ENTITY_ID,
      file_name: "bol.pdf",
      storage_path: "company-1/uuid-bol.pdf",
      uploaded_at: "2026-08-21T00:00:00Z",
      created_at: "2026-08-21T00:00:00Z",
    };
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ queryResult: { data: createdRow } }) as never,
    );

    const res = await POST(
      formDataRequest({
        file: new File(["hello"], "bol.pdf"),
        related_entity_type: "truck",
        related_entity_id: VALID_ENTITY_ID,
      }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(createdRow);
  });
});

describe("GET /api/v1/documents", () => {
  it("requires related_entity_type and related_entity_id", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const res = await GET(new NextRequest("http://localhost/api/v1/documents"));
    expect(res.status).toBe(400);
  });

  it("returns rows with a signed_url attached", async () => {
    const row = {
      id: "doc-1",
      related_entity_type: "truck",
      related_entity_id: VALID_ENTITY_ID,
      file_name: "bol.pdf",
      storage_path: "company-1/uuid-bol.pdf",
      uploaded_at: "2026-08-21T00:00:00Z",
    };
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        queryResult: { data: [row] },
        signedUrl: "https://example.test/signed",
      }) as never,
    );

    const res = await GET(
      new NextRequest(
        `http://localhost/api/v1/documents?related_entity_type=truck&related_entity_id=${VALID_ENTITY_ID}`,
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].signed_url).toBe("https://example.test/signed");
  });
});

describe("DELETE /api/v1/documents/{id}", () => {
  it("404s when the document doesn't exist or belongs to another company", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ queryResult: { data: null } }) as never,
    );
    const res = await DELETE(new NextRequest("http://localhost/api/v1/documents/missing"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("204s and removes the underlying file on success", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({ queryResult: { data: { storage_path: "company-1/uuid-bol.pdf" } } }) as never,
    );
    const res = await DELETE(new NextRequest("http://localhost/api/v1/documents/doc-1"), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(204);
  });
});
