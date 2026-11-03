import { createCrudRoutes } from "@/services/api/crud-routes";
import { createCredentialSchema, updateCredentialSchema } from "@/data/schemas/credentials";
import type { Credential } from "@/types/entities";

const routes = createCrudRoutes<Credential>("credentials", {
  create: createCredentialSchema,
  update: updateCredentialSchema,
});

export const GET = routes.getOne;
export const PATCH = routes.update;
export const DELETE = routes.remove;
