import { z } from "zod";

// Documents don't validate a JSON body like every other entity - the
// request is multipart/form-data (docs/api-contracts.md). This is the one
// piece of their metadata still worth a shared schema: the enum the route
// checks the "related_entity_type" field against.
export const relatedEntityTypeSchema = z.enum(["truck", "trailer", "driver", "load", "expense"]);

// Migration 00085 (document creation spec 2026-11-09): the paperwork
// kinds (existing kinds + the bookkeeping kinds) and the situation a
// document belongs to.
export const documentDocTypeSchema = z.enum([
  "bol", "rate_confirmation", "scale_ticket", "fuel_receipt", "settlement",
  "receipt", "agreement", "invoice", "statement", "other",
]);

export const documentSituationSchema = z.enum(["carrier", "own_authority", "business_records"]);
