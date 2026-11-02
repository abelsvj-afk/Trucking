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

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
