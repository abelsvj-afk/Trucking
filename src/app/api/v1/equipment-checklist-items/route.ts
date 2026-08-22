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

export const GET = routes.list;
export const POST = routes.create;
