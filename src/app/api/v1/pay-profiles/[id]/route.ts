import { createCrudRoutes } from "@/services/api/crud-routes";
import { createPayProfileSchema, updatePayProfileSchema } from "@/data/schemas/pay-profiles";
import type { EmployerPayProfile } from "@/types/entities";

const routes = createCrudRoutes<EmployerPayProfile>("employer_pay_profiles", {
  create: createPayProfileSchema,
  update: updatePayProfileSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
