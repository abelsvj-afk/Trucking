import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadInvoiceSchema, updateLoadInvoiceSchema } from "@/data/schemas/load-invoices";
import type { LoadInvoice } from "@/types/entities";

// GAP-12: receivables (migration 00052).
const routes = createCrudRoutes<LoadInvoice>("load-invoices", {
  create: createLoadInvoiceSchema,
  update: updateLoadInvoiceSchema,
});

export const GET = routes.list;
export const POST = routes.create;
