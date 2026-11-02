import { createCrudRoutes } from "@/services/api/crud-routes";
import { createLoadSchema, updateLoadSchema } from "@/data/schemas/loads";
import { loadTransitionRefusal } from "@/services/api/load-transitions";
import type { Load } from "@/types/entities";

const routes = createCrudRoutes<Load>(
  "loads",
  { create: createLoadSchema, update: updateLoadSchema },
  {
    filterableFields: ["status"],
    // Unit A / F-016: confirming requires the draft-completeness set,
    // completing requires a delivery date - checked on the merged
    // record (see services/api/load-transitions.ts).
    validateMerged: (merged, existing) => loadTransitionRefusal(merged, existing),
  },
);

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
