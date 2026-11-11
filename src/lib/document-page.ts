// Pure helpers for the document Page face (UI/UX Phase 3, spec §2.3).
// The stored model is plain-text lines. These helpers structure those
// lines HONESTLY: a "Label: value" line becomes a meta row, a section
// whose every line is "Label: $amount" becomes a table, route lines
// become a route block, a signature line becomes a signature block —
// and everything else stays a clean typeset line. Nothing is invented:
// every string rendered comes verbatim from the model.

import type { DocumentModel, DocumentSection } from "@/lib/document-templates";
import type { DocumentWithSignedUrl } from "@/types/entities";

export interface LabelValue { label: string; value: string }
export type PageBlock =
  | { kind: "meta"; items: LabelValue[] }
  | { kind: "route"; lines: LabelValue[] }
  | { kind: "table"; rows: LabelValue[]; total: LabelValue | null }
  | { kind: "signature"; text: string }
  | { kind: "lines"; lines: string[] };

export interface PageSection { heading: string | null; blocks: PageBlock[] }

const LABEL_VALUE = /^([^:]{1,60}):\s+(.+)$/;
const MONEY_VALUE = /^\$[\d,]+(?:\.\d{2})?$|^not stated$/;
const ROUTE_LABELS = new Set(["pickup", "delivery", "then", "from", "route"]);

export function parseLabelValue(line: string): LabelValue | null {
  const m = LABEL_VALUE.exec(line.trim());
  if (!m) return null;
  const label = m[1]!.trim();
  const value = m[2]!.trim();
  if (!label || !value) return null;
  // A sentence is not a label: labels are short and carry no period.
  if (label.includes(".") || label.length > 48) return null;
  return { label, value };
}

function isSignatureLine(line: string): boolean {
  return /signature/i.test(line);
}

/** A section is an unambiguous table ONLY when it is headed Charges/Lines
 *  (the structured templates' own headings) and EVERY line parses as
 *  "Label: $amount | not stated". Anything else stays typeset lines. */
export function isTableSection(section: DocumentSection): boolean {
  if (!section.heading || !/^(charges|lines)$/i.test(section.heading.trim())) return false;
  if (section.lines.length === 0) return false;
  return section.lines.every((line) => {
    const lv = parseLabelValue(line);
    return lv !== null && MONEY_VALUE.test(lv.value);
  });
}

export function sectionToBlocks(section: DocumentSection, isFirst: boolean): PageBlock[] {
  if (isTableSection(section)) {
    const rows = section.lines.map((l) => parseLabelValue(l)!).filter((r) => !/^total$/i.test(r.label));
    const totalLine = section.lines.map((l) => parseLabelValue(l)).find((r) => r && /^total$/i.test(r.label));
    return [{ kind: "table", rows, total: totalLine ?? null }];
  }
  const blocks: PageBlock[] = [];
  let pendingLines: string[] = [];
  const flush = () => { if (pendingLines.length) { blocks.push({ kind: "lines", lines: [...pendingLines] }); pendingLines = []; } };

  // First (unheaded) section of the templates is the meta block: a run
  // of Label: value lines at the start becomes the meta grid.
  if (isFirst && !section.heading) {
    const meta: LabelValue[] = [];
    let i = 0;
    while (i < section.lines.length) {
      const lv = parseLabelValue(section.lines[i]!);
      if (!lv) break;
      meta.push(lv); i += 1;
    }
    if (meta.length >= 2) {
      blocks.push({ kind: "meta", items: meta });
      for (const line of section.lines.slice(i)) {
        if (isSignatureLine(line)) { flush(); blocks.push({ kind: "signature", text: line }); }
        else pendingLines.push(line);
      }
      flush();
      return blocks;
    }
  }

  // Route block: a run of Pickup/Delivery/Then lines.
  const route: LabelValue[] = [];
  const rest: string[] = [];
  for (const line of section.lines) {
    const lv = parseLabelValue(line);
    if (lv && ROUTE_LABELS.has(lv.label.toLowerCase())) route.push(lv);
    else rest.push(line);
  }
  if (route.length >= 2 && rest.length === 0) return [{ kind: "route", lines: route }];

  for (const line of section.lines) {
    if (isSignatureLine(line)) { flush(); blocks.push({ kind: "signature", text: line }); }
    else pendingLines.push(line);
  }
  flush();
  return blocks;
}

export function modelToPageSections(model: DocumentModel): PageSection[] {
  return model.sections.map((section, idx) => ({
    heading: section.heading,
    blocks: sectionToBlocks(section, idx === 0),
  }));
}

export type DocumentFaceKind = "model" | "pdf" | "image" | "none";
export type Rendition = "page" | "original" | "scan";

const IMAGE_FILE = /\.(jpe?g|png|webp|heic|heif)$/i;

export function isImageDocument(doc: Pick<DocumentWithSignedUrl, "file_name">): boolean {
  return IMAGE_FILE.test(doc.file_name);
}
export function isPdfDocument(doc: Pick<DocumentWithSignedUrl, "file_name">): boolean {
  return /\.pdf$/i.test(doc.file_name);
}

/** Which Page face a document gets — see the Phase 3 report table. */
export function pageFaceKind(doc: Pick<DocumentWithSignedUrl, "file_name" | "model" | "source">): DocumentFaceKind {
  if (doc.model) return "model";
  if (isImageDocument(doc)) return "image";
  if (isPdfDocument(doc)) return "pdf";
  return "none";
}

/** Renditions that actually exist for this document, with honest labels. */
export function availableRenditions(doc: Pick<DocumentWithSignedUrl, "file_name" | "model" | "source" | "scan_signed_url" | "signed_url">): { value: Rendition; label: string }[] {
  const out: { value: Rendition; label: string }[] = [{ value: "page", label: "Page" }];
  if (isImageDocument(doc)) {
    out.push({ value: "original", label: "Original photo" });
    if (doc.scan_signed_url) out.push({ value: "scan", label: "Scan" });
  } else if (isPdfDocument(doc) && doc.model) {
    // A generated doc's PDF is its second face.
    out.push({ value: "original", label: "PDF" });
  }
  return out;
}

/** Back link for the viewer chrome, from the document's filed-against entity. */
export function backTarget(doc: Pick<DocumentWithSignedUrl, "related_entity_type" | "related_entity_id">): { href: string; label: string } {
  const id = doc.related_entity_id;
  switch (doc.related_entity_type) {
    case "load": return { href: `/loads/${id}`, label: "Load" };
    case "expense": return { href: `/money/expenses/${id}`, label: "Expense" };
    case "truck": return { href: `/more/documents?related_entity_type=truck&related_entity_id=${id}`, label: "Documents" };
    case "trailer": return { href: `/more/documents?related_entity_type=trailer&related_entity_id=${id}`, label: "Documents" };
    case "driver": return { href: `/more/documents?related_entity_type=driver&related_entity_id=${id}`, label: "Documents" };
    default: return { href: "/more/documents", label: "Documents" };
  }
}
