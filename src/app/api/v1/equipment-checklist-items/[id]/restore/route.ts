import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  createEquipmentChecklistItemSchema,
  updateEquipmentChecklistItemSchema,
} from "@/data/schemas/equipment-checklist-items";
import type { EquipmentChecklistItem } from "@/types/entities";

const routes = createCrudRoutes<EquipmentChecklistItem>(
  "equipment_checklist_items",
  { create: createEquipmentChecklistItemSchema, update: updateEquipmentChecklistItemSchema },
  { filterableFields: ["truck_id", "trailer_id"] },
);

// Restore a soft-deleted record (Reliability Unit A): safeguarded
// restore lives in the shared factory - see services/api/crud-routes.ts.
export const POST = routes.restore;
