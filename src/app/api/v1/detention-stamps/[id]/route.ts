import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDetentionStampSchema, updateDetentionStampSchema } from "@/data/schemas/detention-stamps";
import type { DetentionStamp } from "@/types/entities";

// GAP-04: correcting a stamp's time (or removing a mis-tap) happens
// here — the clock must be correctable later, per the register.
const routes = createCrudRoutes<DetentionStamp>(
  "detention_stamps",
  { create: createDetentionStampSchema, update: updateDetentionStampSchema },
);

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
