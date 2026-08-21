import { z } from "zod";

// Documents don't validate a JSON body like every other entity - the
// request is multipart/form-data (docs/api-contracts.md). This is the one
// piece of their metadata still worth a shared schema: the enum the route
// checks the "related_entity_type" field against.
export const relatedEntityTypeSchema = z.enum(["truck", "trailer", "driver", "load"]);
