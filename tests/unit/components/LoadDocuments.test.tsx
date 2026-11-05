// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const docs: unknown[] = [];
const uploads: unknown[] = [];
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    listDocuments: vi.fn(async () => ({ data: docs })),
    uploadDocument: vi.fn(async (m: { file: File; related_entity_type: string; related_entity_id: string }) => (uploads.push(m), {})),
  },
  ApiClientError: class extends Error {},
}));
vi.mock("@/lib/use-live", () => ({ useLiveVersion: () => 0, useLiveConnected: () => false }));

import LoadDocuments, { groupDocuments } from "@/components/LoadDocuments";

const D = (over: Record<string, unknown>) => ({
  id: "d", related_entity_type: "load", related_entity_id: "L1", file_name: "x.jpg", created_at: "2026-11-05T10:00:00Z",
  doc_type: null, photo_purpose: null, deleted_at: null, signed_url: "https://signed/x", scan_signed_url: null,
  extraction_status: "pending", extracted_text: null, ...over,
});

beforeEach(() => { docs.length = 0; uploads.length = 0; });
afterEach(cleanup);

describe("groupDocuments", () => {
  it("groups by what each is (read type, else photo purpose, else Other) and hides deleted ones", () => {
    const g = groupDocuments([
      D({ id: "1", doc_type: "bol" }), D({ id: "2", photo_purpose: "trailer" }), D({ id: "3" }), D({ id: "4", doc_type: "bol", deleted_at: "2026-11-05T00:00:00Z" }),
    ] as never);
    expect(g.map((x) => [x.label, x.docs.map((d) => d.id)])).toEqual([["Bill of lading", ["1"]], ["Other", ["3"]], ["Trailer photos", ["2"]]]);
  });
});

describe("LoadDocuments", () => {
  it("shows thumbnails by group, tap opens the preview, and says plainly when empty", async () => {
    render(<LoadDocuments loadId="L1" />);
    expect(await screen.findByText(/Nothing filed against this trip yet/)).toBeTruthy();
    cleanup();
    docs.push(D({ id: "1", file_name: "bol.jpg", doc_type: "bol" }), D({ id: "2", file_name: "seal.jpg", photo_purpose: "trailer" }));
    render(<LoadDocuments loadId="L1" />);
    expect(await screen.findByText("Bill of lading")).toBeTruthy();
    expect(screen.getByText("Trailer photos")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("View bol.jpg"));
    expect(await screen.findByRole("region", { name: "Preview of bol.jpg" })).toBeTruthy();
  });

  it("uploads against THIS load, and lives inside a <form> so the driving lock makes it inert while moving", async () => {
    render(<LoadDocuments loadId="L1" />);
    const input = (await screen.findByLabelText(/Add a photo or file/)) as HTMLInputElement;
    expect(input.closest("form")).toBeTruthy();
    const file = new File(["x"], "seal.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toMatchObject({ related_entity_type: "load", related_entity_id: "L1" });
  });
});
