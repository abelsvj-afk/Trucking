// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
afterEach(() => cleanup());
import DocumentViewer from "@/components/DocumentViewer";
import type { DocumentWithSignedUrl } from "@/types/entities";

const BASE: DocumentWithSignedUrl = {
  id: "doc-1", company_id: "company-1", related_entity_type: "load",
  related_entity_id: "11111111-1111-4111-8111-111111111111",
  file_name: "bol.jpg", storage_path: "company-1/uuid-bol.jpg",
  uploaded_at: "2026-08-21T00:00:00Z", created_at: "2026-08-21T00:00:00Z",
  scan_storage_path: "company-1/uuid-scan-bol.png", doc_type: "bol",
  extracted_text: "BILL OF LADING\nPickup #: 4417", extracted_fields: null,
  extraction_status: "done", extraction_error: null, extracted_at: "2026-08-21T00:01:00Z",
  deleted_at: null, retention_status: null, retention_error: null, purged_at: null,
  photo_purpose: null, photo_purpose_source: null, photo_purpose_confidence: null,
  signed_url: "https://example.test/original", scan_signed_url: "https://example.test/scan",
  model: null,
};

const MODEL_DOC: DocumentWithSignedUrl = {
  ...BASE, id: "doc-2", file_name: "expense-record.pdf", doc_type: "receipt", source: "generated",
  generator: "app_pdf", extraction_status: "not_applicable", extracted_text: null,
  signed_url: "https://example.test/gen.pdf", scan_signed_url: null, scan_storage_path: null,
  model: {
    title: "Expense Record",
    sections: [
      { heading: null, lines: ["Amount: $250.00", "Date: 2026-11-08", "Category: other"] },
      { heading: "Charges", lines: ["Detention: $75.00", "Layover: not stated"] },
      { heading: null, lines: ["Total: $75.00"] },
    ],
  },
};

describe("DocumentViewer — Page face from stored model", () => {
  it("renders title, meta labels, a table figure from the model — and no figure not in the model", () => {
    render(<DocumentViewer doc={MODEL_DOC} />);
    expect(screen.getAllByText("Expense Record").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Amount").length).toBeGreaterThan(0);
    expect(screen.getByText("$250.00")).toBeTruthy();
    expect(screen.getByText("Detention")).toBeTruthy();
    expect(screen.getAllByText("$75.00").length).toBeGreaterThan(0);
    // No fabricated figure appears anywhere.
    expect(document.body.textContent).not.toContain("$611.20");
    expect(document.body.textContent).not.toContain("1,111.27");
    // Abel reads the model text, never an empty extraction state.
    expect(screen.getByText(/What Abel reads from this page/)).toBeTruthy();
    expect(document.body.textContent).toContain("Amount: $250.00");
  });

  it("model-less generated doc falls back to the embedded PDF, honestly labeled", () => {
    render(<DocumentViewer doc={{ ...MODEL_DOC, model: null }} />);
    expect(screen.getByText(/Created before document pages — showing the PDF/)).toBeTruthy();
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("https://example.test/gen.pdf");
  });

  it("uploaded PDF embeds inline in the Page face", () => {
    render(<DocumentViewer doc={{ ...BASE, file_name: "rate-con.pdf", doc_type: "rate_confirmation", signed_url: "https://example.test/rate.pdf", scan_signed_url: null, model: null }} />);
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("https://example.test/rate.pdf");
    expect(screen.getByText("Download PDF")).toBeTruthy();
    expect(screen.getByText("Open original file")).toBeTruthy();
  });
});

describe("DocumentViewer — photo faces", () => {
  it("shows the photo as the Page, and Original/Scan toggle faces exist", () => {
    render(<DocumentViewer doc={BASE} />);
    // Page face for a photo is the image itself.
    expect(screen.getByAltText("bol.jpg").getAttribute("src")).toBe("https://example.test/original");
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(screen.getByAltText("Scanned version of bol.jpg").getAttribute("src")).toBe("https://example.test/scan");
    fireEvent.click(screen.getByRole("button", { name: "Original photo" }));
    expect(screen.getByAltText("bol.jpg").getAttribute("src")).toBe("https://example.test/original");
  });

  it("shows type + extraction state wording from the shared labels", () => {
    render(<DocumentViewer doc={BASE} />);
    expect(screen.getAllByText(/Bill of lading/).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("Pickup #: 4417");
  });
});
