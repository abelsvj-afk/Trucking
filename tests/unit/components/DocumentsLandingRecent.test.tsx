// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
afterEach(() => cleanup());

const recent = [
  { id: "doc-r1", file_name: "bol.jpg", related_entity_type: "load", related_entity_id: "L1", uploaded_at: "2026-11-09T00:00:00Z", created_at: "2026-11-09T00:00:00Z", doc_type: "bol", signed_url: null, scan_signed_url: null, extraction_status: "done", extracted_text: null },
  { id: "doc-r2", file_name: "expense-record.pdf", related_entity_type: "expense", related_entity_id: "E1", uploaded_at: "2026-11-08T00:00:00Z", created_at: "2026-11-08T00:00:00Z", doc_type: "receipt", signed_url: null, scan_signed_url: null, extraction_status: "not_applicable", extracted_text: null },
];
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    listRecentDocuments: vi.fn(async () => ({ data: recent })),
    listDocuments: vi.fn(async () => ({ data: [] })),
    listDeletedDocuments: vi.fn(async () => ({ data: [] })),
    listCleanupIncidents: vi.fn(async () => ({ data: [] })),
    searchDocuments: vi.fn(async () => ({ data: [] })),
  },
  ApiClientError: class extends Error {},
}));
vi.mock("@/lib/use-picker-list", () => ({ usePickerList: () => [] }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

import DocumentsPage from "@/app/(app)/more/documents/page";

describe("Documents landing — Recent list", () => {
  it("renders the recent documents above the picker, each linking to its document page", async () => {
    render(<DocumentsPage />);
    expect(await screen.findByText("Bill of lading")).toBeTruthy();
    expect(screen.getByText("Receipt")).toBeTruthy();
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("/more/documents/doc-r1");
    expect(links).toContain("/more/documents/doc-r2");
    // The Type/Record picker still exists (coverage: nothing removed).
    expect(screen.getByLabelText("Type")).toBeTruthy();
    expect(screen.getByLabelText("Record")).toBeTruthy();
  });
});
