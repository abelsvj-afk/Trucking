import { describe, expect, it } from "vitest";
import { parseDispatchTrip, tripToCreateLoadArgs } from "@/lib/dispatch-trip";

const MSG = `🚛 NEW TRIP 1852 HAS BEEN ASSIGNED

🏁 STOP 1
SHIPPER/CONSIGNEE: Bekaert
📍 ADDRESS: 810 South 28th Street BLDG C, Van Buren, AR 72956
APPT: 11/04/2026 00:00 CST
TYPE: Pickup Stop

=======================

🏁 STOP 2
SHIPPER/CONSIGNEE: St. Lucie County Solid Waste
📍 ADDRESS: 6120 Glades Cut Off Road , Fort Pierce, FL 34981
APPT: 11/05/2026 00:00 EST
TYPE: Delivery Stop

=======================

🧾 TRIP DETAILS

BROKER: AmeriLux Logistics
REF #: ACCENT12558481
DEADHEAD: 120.00 mi
LOADED DISTANCE: 1,213.91 mi
TOTAL DISTANCE: 1,333.91 mi
===================================
❗️Send Picture of trailer in PU/DEL
❗️SEND SEAL PICTURE
❗️SIGNED BOL - should be sent to the group.
❗️Update us in EVERY STOPS.
❗️Do not leave the facility before dispatcher APPROVAL 

📵NO TEXTING While driving
🚫NO SPEEDING at any time
✅ PLEASE CHECK AND CONFIRM`;

describe("parseDispatchTrip - Trip 1852", () => {
  const trip = parseDispatchTrip(MSG)!;
  it("reads the trip, broker, reference and exact miles", () => {
    expect(trip.tripNumber).toBe("1852");
    expect(trip.brokerName).toBe("AmeriLux Logistics");
    expect(trip.brokerReference).toBe("ACCENT12558481");
    expect([trip.deadheadMiles, trip.loadedMiles, trip.totalMiles]).toEqual([120, 1213.91, 1333.91]);
  });
  it("reads both stops with facility-local appointments", () => {
    expect(trip.stops).toHaveLength(2);
    expect(trip.stops[0]).toMatchObject({ kind: "pickup", name: "Bekaert", cityState: "Van Buren, AR", appointmentTz: "America/Chicago" });
    // 00:00 CST on 11/04 = 06:00 UTC (Central is UTC-6 after DST ended 11/01)
    expect(trip.stops[0]!.appointmentAt).toBe("2026-11-04T06:00:00.000Z");
    expect(trip.stops[1]).toMatchObject({ kind: "delivery", cityState: "Fort Pierce, FL", appointmentTz: "America/New_York" });
    expect(trip.stops[1]!.appointmentAt).toBe("2026-11-05T05:00:00.000Z");
  });
  it("keeps the dispatcher's requirements, not the safety slogans", () => {
    expect(trip.tasks).toEqual([
      "Send Picture of trailer in PU/DEL",
      "SEND SEAL PICTURE",
      "SIGNED BOL - should be sent to the group.",
      "Update us in EVERY STOPS.",
      "Do not leave the facility before dispatcher APPROVAL",
    ]);
  });
  it("builds create_load arguments with city/state, dates, zones, exact miles", () => {
    const args = tripToCreateLoadArgs(trip)!;
    expect(args).toMatchObject({
      origin: "Van Buren, AR", destination: "Fort Pierce, FL", trip_number: "1852",
      broker_reference: "ACCENT12558481", deadhead_miles: 120, loaded_miles: 1213.91, miles: 1334,
      pickup_date: "2026-11-04", delivery_date: "2026-11-05", pickup_tz: "America/Chicago", delivery_tz: "America/New_York",
    });
    expect((args.stops as unknown[]).length).toBe(2);
  });
});

describe("parseDispatchTrip - other shapes", () => {
  it("returns null for anything that is not this format (the model path handles it)", () => {
    expect(parseDispatchTrip("Hey can you pick up at 5 tomorrow?")).toBeNull();
  });
  it("handles more than two stops and a missing zone without inventing an instant", () => {
    const t = parseDispatchTrip(`NEW TRIP 77 HAS BEEN ASSIGNED
STOP 1
SHIPPER/CONSIGNEE: A
ADDRESS: 1 Main St, Dallas, TX 75001
APPT: 12/01/2026 08:00
TYPE: Pickup Stop
STOP 2
SHIPPER/CONSIGNEE: B
ADDRESS: 2 Main St, Tulsa, OK 74101
APPT: 12/01/2026 14:00 CST
TYPE: Delivery Stop
STOP 3
SHIPPER/CONSIGNEE: C
ADDRESS: 3 Main St, Wichita, KS 67201
APPT: 12/02/2026 09:00 CST
TYPE: Delivery Stop`)!;
    expect(t.stops).toHaveLength(3);
    expect(t.stops[0]!.appointmentAt).toBeNull();
    expect(t.stops[0]!.appointmentText).toBe("12/01/2026 08:00");
    expect(tripToCreateLoadArgs(t)).toMatchObject({ origin: "Dallas, TX", destination: "Wichita, KS" });
  });
});
