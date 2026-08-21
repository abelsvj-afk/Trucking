import { z } from "zod";

export const createBrokerSchema = z.object({
  name: z.string().min(1, "name is required."),
  mc_number: z.string().optional(),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  notes: z.string().optional(),
});

export const updateBrokerSchema = createBrokerSchema.partial();
