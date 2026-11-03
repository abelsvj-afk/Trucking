// GAP-11 (Fresh-Eyes Register 2026-11-02): credential register rows.

import { z } from "zod";

export const credentialKindSchema = z.enum([
  "cdl",
  "medical_card",
  "annual_inspection",
  "registration_irp",
  "insurance",
  "other",
]);

const credentialFieldsSchema = z.object({
  kind: credentialKindSchema,
  label: z.string().min(1, "label is required."),
  driver_id: z.string().uuid().nullable().optional(),
  truck_id: z.string().uuid().nullable().optional(),
  expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expires_on must be YYYY-MM-DD."),
  document_id: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const createCredentialSchema = credentialFieldsSchema;
export const updateCredentialSchema = credentialFieldsSchema.partial();
