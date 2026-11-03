import { createCrudRoutes } from "@/services/api/crud-routes";
import { createDetentionStampSchema, updateDetentionStampSchema } from "@/data/schemas/detention-stamps";
import type { DetentionStamp } from "@/types/entities";

// GAP-04: stamps are created through the load-scoped route (it owns
// the summary response); this collection route exists for filtered
// reads (the day-wrap's unclaimed-detention scan, GAP-08).
const routes = createCrudRoutes<DetentionStamp>(
  "detention_stamps",
  { create: createDetentionStampSchema, update: updateDetentionStampSchema },
  { filterableFields: ["load_id"] },
);

export const GET = routes.list;
