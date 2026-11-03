import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadInvoiceSchema, updateLoadInvoiceSchema } from "@/data/schemas/load-invoices";
import type { LoadInvoice } from "@/types/entities";

const routes = createCrudRoutes<LoadInvoice>("load-invoices", {
  create: createLoadInvoiceSchema,
  update: updateLoadInvoiceSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
