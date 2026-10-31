// Driver MVP (docs/design/driver-mvp.md §5). What came in, what the AI
// produced, and what the owner actually sent - captured only on the
// owner's explicit save (web) or by his own private bot (telegram).

import { z } from "zod";

export const dispatchExchangeSourceSchema = z.enum(["web", "telegram"]);

const dispatchExchangeFieldsSchema = z.object({
  incoming_message: z.string().min(1, "incoming_message is required."),
  ai_translation: z.string().nullable().optional(),
  ai_suggested_reply_en: z.string().nullable().optional(),
  ai_suggested_reply_es: z.string().nullable().optional(),
  actual_reply_sent: z.string().nullable().optional(),
  source: dispatchExchangeSourceSchema,
});

export const createDispatchExchangeSchema = dispatchExchangeFieldsSchema;
export const updateDispatchExchangeSchema = dispatchExchangeFieldsSchema.partial();
