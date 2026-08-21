import { z } from "zod";

export const createCustomerSchema = z.object({
  name: z.string().min(1, "name is required."),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  notes: z.string().optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();
