// The fleet-asset write tools: trucks and trailers (profile, appliances, photos).
// Split out of tools-write.ts (decomposition pass, behavior unchanged): the same
// tools, pushed onto the same list in the same order.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { changedFields, dateString, idParam, makeCreateTool, makeUpdateTool, uuid, type Row } from "./tools-write-helpers";
import { definedOnly, fetchLiveRow, isMissingColumnError, patchLiveRow, validateWith } from "./tool-helpers";
import { createTrailerSchema, updateTrailerSchema } from "@/data/schemas/trailers";
import { createTruckSchema, updateTruckSchema } from "@/data/schemas/trucks";
import { propagateMileage, MILEAGE_SOURCES, MILEAGE_SOURCE_LABELS, type MileageSource } from "@/services/fleet/mileage";

export function pushFleetTools(store: BotBrainStore, tools: AgentTool[]): void {
  // --- Fleet --------------------------------------------------------

  const truckBaseParams = {
    unit_number: { type: "string" },
    vin: { type: "string" },
    make: { type: "string" },
    model: { type: "string" },
    year: { type: "number" },
    status: { type: "string", enum: ["active", "maintenance", "inactive"] },
    current_mileage: { type: "number" },
    truck_type: { type: "string", description: "What kind of truck it is (sleeper, day cab, box truck...) in his words or the app's picklist values." },
    photo_document_id: { type: "string", description: "Documents row id of this truck's profile photo (from a photo he sent)." },
    mileage_source: {
      type: "string",
      enum: MILEAGE_SOURCES,
      description:
        "Where a current_mileage value came from (Image Intelligence §5.3 provenance): odometer_photo when read off a dash photo, owner_said when he states it. Omit when not setting mileage.",
    },
  };
  const truckProfileFields = {
    height_in: z.number().positive().optional(),
    length_in: z.number().positive().optional(),
    weight_lbs: z.number().positive().optional(),
    governed_speed_mph: z.number().positive().optional(),
    tank_capacity_gallons: z.number().positive().optional(),
    avg_mpg: z.number().positive().optional(),
    appliances: z.array(z.string().min(1)).optional(),
    appliance_notes: z.string().optional(),
  };
  const truckProfileParamProps = {
    height_in: { type: "number" },
    length_in: { type: "number" },
    weight_lbs: { type: "number" },
    governed_speed_mph: { type: "number" },
    tank_capacity_gallons: { type: "number" },
    avg_mpg: { type: "number" },
    appliances: {
      type: "array",
      items: { type: "string" },
      description: "Appliance inventory in the cab, e.g. [\"fridge\", \"microwave\"] - Smart Path's food routing keys off this.",
    },
    appliance_notes: { type: "string" },
  };
  const PROFILE_KEYS = Object.keys(truckProfileFields);

  tools.push(
    makeCreateTool(store, {
      name: "create_truck",
      description: "Add a truck to his fleet (Trucks tab).",
      parameters: { type: "object", properties: truckBaseParams, required: ["unit_number"] },
      botSchema: createTruckSchema,
      table: "trucks",
      label: "truck",
      toRow: (args) => definedOnly(args),
      rowSchema: createTruckSchema,
      summarize: (args) => `Truck: unit ${args.unit_number}`,
      confirm: (args) => `Added truck ${args.unit_number}.`,
    }),
    {
      name: "update_truck",
      description:
        "Update a truck - base details (unit number, status, mileage, type, profile photo) and/or its Smart Path profile: dimensions, governed speed, tank, MPG, and the APPLIANCE INVENTORY (fridge, microwave, hot plate, inverter...). Profile fields live in the Smart Path part of the database; if that hasn't landed yet the tool says so instead of pretending to save them. Mileage moves through the §5.3 propagation rule: it never goes backwards - a lower value is refused and reported, and every accepted value is stamped with its source.",
      parameters: {
        type: "object",
        properties: {
          truck_id: idParam("truck_id", "truck"),
          ...truckBaseParams,
          ...truckProfileParamProps,
        },
        required: ["truck_id"],
      },
      access: "write",
      validateArgs: validateWith(
        updateTruckSchema
          .extend({ truck_id: uuid })
          .extend(truckProfileFields)
          .extend({ mileage_source: z.enum(MILEAGE_SOURCES as [MileageSource, ...MileageSource[]]).optional() }),
      ),
      summarize: (args) =>
        `Update the truck: ${changedFields(args as Row, "truck_id", ["mileage_source"])}` +
        `${Array.isArray((args as Row).appliances) ? ` — appliances: ${((args as Row).appliances as string[]).join(", ")}` : ""}`,
      async run(args) {
        const schema = updateTruckSchema
          .extend({ truck_id: uuid })
          .extend(truckProfileFields)
          .extend({ mileage_source: z.enum(MILEAGE_SOURCES as [MileageSource, ...MileageSource[]]).optional() });
        const parsed = schema.parse(args) as Row;
        const { client, companyId } = store;
        const id = String(parsed.truck_id);
        await fetchLiveRow(client, "trucks", companyId, id, "truck");
        const all = definedOnly(parsed);
        delete all.truck_id;
        // §5.3: mileage leaves the plain patch and goes through
        // the propagation helper (provenance + never-backwards).
        const mileageSource = all.mileage_source as MileageSource | undefined;
        delete all.mileage_source;
        const mileageValue = typeof all.current_mileage === "number" ? all.current_mileage : undefined;
        delete all.current_mileage;
        const profilePatch: Row = {};
        const basePatch: Row = {};
        for (const [key, value] of Object.entries(all)) {
          if (PROFILE_KEYS.includes(key)) profilePatch[key] = value;
          else basePatch[key] = value;
        }
        if (Object.keys(profilePatch).length > 0) {
          // Profile first: if the columns aren't in the database yet
          // (Smart Path migration 00017), fail BEFORE touching the
          // base row and say exactly that - no silent partial save.
          const { error } = await client
            .from("trucks")
            .update(profilePatch)
            .eq("id", id)
            .eq("company_id", companyId)
            .is("deleted_at", null);
          if (error) {
            if (isMissingColumnError(error)) {
              throw new Error(
                "The truck profile fields (size/speed/appliances) aren't in the database yet - they arrive with the Smart Path update. Nothing was changed.",
              );
            }
            throw new Error(error.message);
          }
        }
        if (Object.keys(basePatch).length > 0) {
          updateTruckSchema.parse(basePatch);
          await patchLiveRow(client, "trucks", companyId, id, basePatch);
        }
        let mileageNote = "";
        if (mileageValue !== undefined) {
          const source = mileageSource ?? "owner_said";
          const outcome = await propagateMileage(client, companyId, {
            truckId: id,
            miles: mileageValue,
            source,
          });
          mileageNote = outcome.applied
            ? ` Mileage now ${Math.round(mileageValue).toLocaleString("en-US")} (from ${MILEAGE_SOURCE_LABELS[source]}${outcome.provenanceRecorded ? "" : "; provenance stamp pending the mileage migration"}).`
            : ` Mileage NOT changed: ${Math.round(mileageValue).toLocaleString("en-US")} would move the truck backwards from ${outcome.previousMiles?.toLocaleString("en-US") ?? "its recorded mileage"} - if the recorded number is wrong, say so and it gets corrected openly.`;
        }
        const changed = changedFields(parsed, "truck_id", ["mileage_source"]);
        return `Updated the truck (${changed}).${mileageNote}`;
      },
    },
    makeCreateTool(store, {
      name: "create_trailer",
      description: "Add a trailer to his fleet (Trailers tab).",
      parameters: {
        type: "object",
        properties: {
          unit_number: { type: "string" },
          vin: { type: "string" },
          trailer_type: { type: "string" },
          status: { type: "string", enum: ["active", "maintenance", "inactive"] },
        },
        required: ["unit_number"],
      },
      botSchema: createTrailerSchema,
      table: "trailers",
      label: "trailer",
      toRow: (args) => definedOnly(args),
      rowSchema: createTrailerSchema,
      summarize: (args) => `Trailer: unit ${args.unit_number}`,
      confirm: (args) => `Added trailer ${args.unit_number}.`,
    }),
    makeUpdateTool(store, {
      name: "update_trailer",
      description: "Update a trailer (unit number, type, status, profile photo).",
      parameters: {
        type: "object",
        properties: {
          trailer_id: idParam("trailer_id", "trailer"),
          unit_number: { type: "string" },
          vin: { type: "string" },
          trailer_type: { type: "string" },
          status: { type: "string", enum: ["active", "maintenance", "inactive"] },
          photo_document_id: { type: "string", description: "Documents row id of this trailer's picture (from a photo he sent)." },
        },
        required: ["trailer_id"],
      },
      botSchema: updateTrailerSchema.extend({ trailer_id: uuid }),
      table: "trailers",
      label: "trailer",
      idKey: "trailer_id",
      toPatch: (args) => definedOnly(args),
      patchSchema: updateTrailerSchema,
      summarize: (args) => `Update the trailer: ${changedFields(args, "trailer_id")}`,
      confirm: (args) => `Updated the trailer (${changedFields(args, "trailer_id")}).`,
    }),
  );

}
