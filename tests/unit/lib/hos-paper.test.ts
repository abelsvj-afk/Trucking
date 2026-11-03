// UH-12 regression tests (union fix round).
import { describe, expect, it } from "vitest";
import { buildPaperDocMap, hosPaperLabel, hosRowPaperSuffix } from "@/lib/hos-paper";
import type { Document, DutyLog } from "@/types/entities";

const doc = (over: Partial<Document>): Document =>
  ({ id: "d1", photo_purpose: "paper_log", extracted_fields: { paper_log_complete: false, paper_log_date: "2026-11-01" }, ...over }) as Document;
const row = (over: Partial<DutyLog>): DutyLog =>
  ({ id: "r1", source: "paper_photo", source_document_id: "d1", ...over }) as DutyLog;

describe("UH-12: shared HOS paper/partial labels", () => {
  it("Home label names paper + partial state", () => {
    const map = buildPaperDocMap([doc({})]);
    expect(hosPaperLabel([row({})], map)).toMatch(/paper log sheet/);
    expect(hosPaperLabel([row({})], map)).toMatch(/partial/);
    expect(hosRowPaperSuffix(row({}), map)).toContain("(partial day)");
  });
  it("no paper rows -> no label", () => {
    const map = buildPaperDocMap([doc({})]);
    expect(hosPaperLabel([row({ source: "app", source_document_id: null })], map)).toBeNull();
  });
});
