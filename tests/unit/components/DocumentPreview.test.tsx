// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// vitest globals are off in this repo, so RTL's auto-cleanup never
// registers - clean up by hand or renders leak across tests.
afterEach(() => cleanup());
import { DocumentPreview } from "@/components/DocumentPreview";
import type { DocumentWithSignedUrl } from "@/types/entities";

const BASE_DOC: DocumentWithSignedUrl = {
  id: "doc-1",
  company_id: "company-1",
  related_entity_type: "load",
  related_entity_id: "11111111-1111-4111-8111-111111111111",
  file_name: "bol.jpg",
  storage_path: "company-1/uuid-bol.jpg",
  uploaded_at: "2026-08-21T00:00:00Z",
  created_at: "2026-08-21T00:00:00Z",
  scan_storage_path: "company-1/uuid-scan-bol.png",
  doc_type: "bol",
  extracted_text: "BILL OF LADING\nPickup #: 4417",
  extracted_fields: { pickup_number: "4417" },
  extraction_status: "done",
  extraction_error: null,
  extracted_at: "2026-08-21T00:01:00Z",
  signed_url: "https://example.test/original",
  scan_signed_url: "https://example.test/scan",
};

describe("DocumentPreview", () => {
  it("shows the original by default and switches to the scan on toggle", () => {
    render(<DocumentPreview doc={BASE_DOC} />);

    const img = screen.getByAltText("bol.jpg");
    expect(img.getAttribute("src")).toBe("https://example.test/original");
    expect(screen.getByRole("button", { name: "Original" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Scan" }));

    const scanImg = screen.getByAltText("Scanned version of bol.jpg");
    expect(scanImg.getAttribute("src")).toBe("https://example.test/scan");
    expect(screen.getByRole("button", { name: "Scan" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("disables the Scan toggle when no scan rendition exists", () => {
    render(
      <DocumentPreview doc={{ ...BASE_DOC, scan_storage_path: null, scan_signed_url: null }} />,
    );
    expect(screen.getByRole("button", { name: "Scan" })).toHaveProperty("disabled", true);
    expect(screen.getByAltText("bol.jpg").getAttribute("src")).toBe("https://example.test/original");
  });

  it("shows the document type, extraction state, and the text the assistant reads", () => {
    render(<DocumentPreview doc={BASE_DOC} />);
    expect(screen.getByText("Bill of lading")).toBeTruthy();
    expect(screen.getByText(/Text extracted/)).toBeTruthy();
    expect(screen.getByText(/Pickup #: 4417/)).toBeTruthy();
  });

  it("explains a failed extraction in plain words", () => {
    render(
      <DocumentPreview
        doc={{
          ...BASE_DOC,
          extraction_status: "failed",
          extraction_error: "The document couldn't be read automatically.",
          extracted_text: null,
        }}
      />,
    );
    expect(screen.getByText("The document couldn't be read automatically.")).toBeTruthy();
  });
});
