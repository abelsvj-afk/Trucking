// GAP-01: extracted fields → proposed record items (pure mapping).
// Staging/validation rides stage-recordables (covered by the bot
// suite); what matters here is that the right records get proposed
// with the right values, and settlements propose nothing.

import { describe, expect, it } from "vitest";
import {
  buildDocumentProposalItems,
  type ProposalContext,
} from "@/services/documents/document-proposals";

function ctx(overrides: Partial<ProposalContext> = {}): ProposalContext {
  return {
    document: {
      id: "doc1",
      doc_type: "fuel_receipt",
      extracted_fields: {},
      extracted_text: "",
      related_entity_type: "company",
      related_entity_id: "c1",
    },
    trucks: [{ id: "t1", unit_number: "TRK-2" }],
    loads: [],
    facilities: [],
    ...overrides,
  };
}

describe("fuel receipts", () => {
  it("proposes a fuel purchase with the receipt's own numbers", () => {
    const items = buildDocumentProposalItems(
      ctx({
        document: {
          id: "doc1",
          doc_type: "fuel_receipt",
          extracted_fields: {
            gallons: 142.6,
            total_amount: 554.79,
            price_per_gallon: 3.89,
            station_name: "Love's",
            truck_number: "TRK-2",
          },
          extracted_text: "Love's\n142.6 gal @ 3.89\nTotal $554.79",
          related_entity_type: "company",
          related_entity_id: "c1",
        },
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.tool_name).toBe("create_fuel_purchase");
    expect(items[0]!.args).toMatchObject({ total_dollars: 554.79, gallons: 142.6, truck_id: "t1" });
    expect(items[0]!.source_quote).toContain("554.79");
  });

  it("proposes nothing when the receipt states no total (never computes one)", () => {
    const items = buildDocumentProposalItems(
      ctx({
        document: {
          id: "doc1",
          doc_type: "fuel_receipt",
          extracted_fields: { gallons: 100, price_per_gallon: 3.5 },
          extracted_text: "100 gal @ 3.50",
          related_entity_type: "company",
          related_entity_id: "c1",
        },
      }),
    );
    expect(items).toEqual([]);
  });
});

describe("rate confirmations", () => {
  const rateConFields = {
    rate_amount: 3900,
    weight_lbs: 42000,
    origin_city: "Atlanta",
    origin_state: "GA",
    destination_city: "Wildwood",
    destination_state: "FL",
    receiver: "Tyson Foods",
    shipper: "Pilgrim's Pride",
  };
  const rateConText = "Rate Confirmation\nAtlanta GA to Wildwood FL\n$3,900.00\n42,000 lbs";

  it("creates the load and both facilities when nothing matches", () => {
    const items = buildDocumentProposalItems(
      ctx({
        document: {
          id: "doc2",
          doc_type: "rate_confirmation",
          extracted_fields: rateConFields,
          extracted_text: rateConText,
          related_entity_type: "company",
          related_entity_id: "c1",
        },
      }),
    );
    const tools = items.map((i) => i.tool_name);
    expect(tools).toEqual(["create_load", "create_facility", "create_facility"]);
    expect(items[0]!.args).toMatchObject({
      origin: "Atlanta, GA",
      destination: "Wildwood, FL",
      rate_dollars: 3900,
      weight_lbs: 42000,
      origin_state: "GA",
      destination_state: "FL",
    });
  });

  it("updates the matching draft load instead of creating a duplicate", () => {
    const items = buildDocumentProposalItems(
      ctx({
        document: {
          id: "doc2",
          doc_type: "rate_confirmation",
          extracted_fields: rateConFields,
          extracted_text: rateConText,
          related_entity_type: "company",
          related_entity_id: "c1",
        },
        loads: [
          { id: "l9", origin: "Atlanta, GA", destination: "Wildwood, FL", status: "draft" },
        ],
      }),
    );
    expect(items[0]!.tool_name).toBe("update_load");
    expect(items[0]!.args).toMatchObject({ load_id: "l9", rate_dollars: 3900 });
  });

  it("does not re-propose a facility it already remembers", () => {
    const items = buildDocumentProposalItems(
      ctx({
        document: {
          id: "doc2",
          doc_type: "rate_confirmation",
          extracted_fields: rateConFields,
          extracted_text: rateConText,
          related_entity_type: "company",
          related_entity_id: "c1",
        },
        facilities: [{ id: "f1", name: "Tyson Foods", city: "Wildwood" }],
      }),
    );
    const facilityItems = items.filter((i) => i.tool_name === "create_facility");
    expect(facilityItems).toHaveLength(1);
    expect(facilityItems[0]!.args).toMatchObject({ name: "Pilgrim's Pride" });
  });
});

describe("bols and scale tickets", () => {
  it("a company-filed BOL proposes attach + completion on its one matching load", () => {
    const items = buildDocumentProposalItems(
      ctx({
        document: {
          id: "doc3",
          doc_type: "bol",
          extracted_fields: { bol_number: "BOL-88", destination_city: "Wildwood" },
          extracted_text: "Bill of Lading BOL-88\nDeliver to Wildwood",
          related_entity_type: "company",
          related_entity_id: "c1",
        },
        loads: [{ id: "l9", origin: "Atlanta, GA", destination: "Wildwood, FL", status: "confirmed" }],
      }),
    );
    expect(items.map((i) => i.tool_name)).toEqual(["attach_document", "update_load"]);
    expect(items[1]!.args).toMatchObject({ load_id: "l9", status: "completed" });
  });

  it("a scale ticket lands its weight on the attached load", () => {
    const items = buildDocumentProposalItems(
      ctx({
        document: {
          id: "doc4",
          doc_type: "scale_ticket",
          extracted_fields: { weight_lbs: 41850 },
          extracted_text: "Gross 41,850 lb",
          related_entity_type: "load",
          related_entity_id: "l9",
        },
        loads: [{ id: "l9", origin: "Atlanta, GA", destination: "Wildwood, FL", status: "confirmed" }],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.args).toMatchObject({ load_id: "l9", weight_lbs: 41850 });
  });
});

describe("exclusions", () => {
  it("settlements propose nothing (Abel Phase D owns them)", () => {
    const items = buildDocumentProposalItems(
      ctx({
        document: {
          id: "doc5",
          doc_type: "settlement",
          extracted_fields: { total_amount: 2100 },
          extracted_text: "Settlement total $2,100.00",
          related_entity_type: "company",
          related_entity_id: "c1",
        },
      }),
    );
    expect(items).toEqual([]);
  });
});
