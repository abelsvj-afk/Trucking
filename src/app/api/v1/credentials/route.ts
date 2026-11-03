import { createCrudRoutes } from "@/services/api/crud-routes";
import { createCredentialSchema, updateCredentialSchema } from "@/data/schemas/credentials";
import type { Credential } from "@/types/entities";

// GAP-11: credential register (migration 00048).
const routes = createCrudRoutes<Credential>("credentials", {
  create: createCredentialSchema,
  update: updateCredentialSchema,
});

export const GET = routes.list;
export const POST = routes.create;
