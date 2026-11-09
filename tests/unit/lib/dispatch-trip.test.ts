import { describe, expect, it } from "vitest";
import { parseDispatchTrip, tripToCreateLoadArgs } from "@/lib/dispatch-trip";

const MSG = `🚛 NEW TRIP 1234 HAS BEEN ASSIGNED

🏁 STOP 1
SHIPPER/CONSIGNEE: Example Steel Co
📍 ADDRESS: 100 Example Way, Springfield, MO 65801
APPT: 11/04/2026 00:00 CST
TYPE: Pickup Stop

=======================

🏁 STOP 2
SHIPPER/CONSIGNEE: Sample County Recycling
📍 ADDRESS: 200 Sample Road , Tampa, FL 33601
APPT: 11/05/2026 00:00 EST
TYPE: Delivery Stop

=======================

🧾 TRIP DETAILS

BROKER: Example Logistics
REF #: REF123456
DEADHEAD: 120.00 mi
LOADED DISTANCE: 900.50 mi
TOTAL DISTANCE: 1,000.50 mi
===================================
❗️Send Picture of trailer in PU/DEL
❗️SEND SEAL PICTURE
❗️SIGNED BOL - should be sent to the group.
❗️Update us in EVERY STOPS.
❗️Do not leave the facility before dispatcher APPROVAL 

📵NO TEXTING While driving
🚫NO SPEEDING at any time
✅ PLEASE CHECK AND CONFIRM`;

describe("parseDispatchTrip - Trip 1234", () => {
  const trip = parseDispatchTrip(MSG)!;
  it("reads the trip, broker, reference and exact miles", () => {
    expect(trip.tripNumber).toBe("1234");
    expect(trip.brokerName).toBe("Example Logistics");
    expect(trip.brokerReference).toBe("REF123456");
    expect([trip.deadheadMiles, trip.loadedMiles, trip.totalMiles]).toEqual([120, 900.5, 1000.5]);
  });
  it("reads both stops with facility-local appointments", () => {
    expect(trip.stops).toHaveLength(2);
    expect(trip.stops[0]).toMatchObject({ kind: "pickup", name: "Example Steel Co", cityState: "Springfield, MO", appointmentTz: "America/Chicago" });
    // 00:00 CST on 11/04 = 06:00 UTC (Central is UTC-6 after DST ended 11/01)
    expect(trip.stops[0]!.appointmentAt).toBe("2026-11-04T06:00:00.000Z");
    expect(trip.stops[1]).toMatchObject({ kind: "delivery", cityState: "Tampa, FL", appointmentTz: "America/New_York" });
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
      origin: "Springfield, MO", destination: "Tampa, FL", trip_number: "1234",
      broker_reference: "REF123456", deadhead_miles: 120, loaded_miles: 900.5, miles: 1001,
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

// Regression fixture #1 (brief fix 15): the real Trip 1874 dispatch text
// that lost Seminole on 2026-11-09 - three stop blocks, the third headed
// "LOT TO" with no STOP number, miles that do not add up as printed.
const TRIP_1874 = `🚛 NEW TRIP 1874 HAS BEEN ASSIGNED

🏁 STOP 1
SHIPPER/CONSIGNEE: Kontoor Panama City
📍 ADDRESS: 1 Seaport Drive, Panama City, FL 32401
APPT: 11/10/2026 08:00 CST-11/10/2026 16:00 CST
TYPE: Pickup Stop

=======================

🏁 STOP 2
SHIPPER/CONSIGNEE: Kontoor Seminole
📍 ADDRESS: 1400 Wrangler Boulevard West, Seminole, OK 74868
APPT: 11/12/2026 12:00 CST
TYPE: Delivery Stop

=======================

LOT TO
SHIPPER/CONSIGNEE: Kontoor Panama City
📍 ADDRESS: 1 Seaport Drive, Panama City, FL 32401
APPT: 11/16/2026 12:00 CST
TYPE: Delivery Stop

=======================

🧾 TRIP DETAILS

BROKER: ITS Logistics LLC
REF #: 5113964
DEADHEAD: 220.29 mi
LOADED DISTANCE: 890.98 mi
TOTAL DISTANCE: 1,178.27 mi
===================================
❗️Send Picture of trailer in PU/DEL
❗️SEND SEAL PICTURE
❗️SIGNED BOL - should be sent to the group.
❗️Update us in EVERY STOPS.
❗️Do not leave the facility before dispatcher APPROVAL

📵NO TEXTING While driving
🚫NO SPEEDING at any time
✅ PLEASE CHECK AND CONFIRM`;

describe("parseDispatchTrip - Trip 1874 (the LOT TO regression)", () => {
  const trip = parseDispatchTrip(TRIP_1874)!;
  it("returns THREE stops - the lot-to leg is its own stop, Seminole survives", () => {
    expect(trip.stops).toHaveLength(3);
    expect(trip.stops[0]).toMatchObject({ kind: "pickup", name: "Kontoor Panama City", cityState: "Panama City, FL" });
    expect(trip.stops[1]).toMatchObject({ kind: "delivery", name: "Kontoor Seminole", cityState: "Seminole, OK", address: "1400 Wrangler Boulevard West, Seminole, OK 74868" });
    expect(trip.stops[2]).toMatchObject({ kind: "delivery", name: "Kontoor Panama City", cityState: "Panama City, FL", header: "LOT TO" });
  });
  it("no stop's fields contain another stop's data", () => {
    expect(trip.stops[1]!.appointmentText).toBe("11/12/2026 12:00 CST");
    expect(trip.stops[2]!.appointmentText).toBe("11/16/2026 12:00 CST");
    // 11/12 12:00 CST = 18:00 UTC; 11/16 12:00 CST = 18:00 UTC
    expect(trip.stops[1]!.appointmentAt).toBe("2026-11-12T18:00:00.000Z");
    expect(trip.stops[2]!.appointmentAt).toBe("2026-11-16T18:00:00.000Z");
  });
  it("parses the appointment window END, not just the start", () => {
    // 11/10 08:00 CST = 14:00 UTC; window end 16:00 CST = 22:00 UTC
    expect(trip.stops[0]!.appointmentAt).toBe("2026-11-10T14:00:00.000Z");
    expect(trip.stops[0]!.appointmentEndAt).toBe("2026-11-10T22:00:00.000Z");
  });
  it("keeps the miles as printed and flags that they do not add up", () => {
    expect([trip.deadheadMiles, trip.loadedMiles, trip.totalMiles]).toEqual([220.29, 890.98, 1178.27]);
    expect(trip.milesMismatch).toEqual({ printedTotal: 1178.27, partsSum: 1111.27 });
  });
  it("cross-check is clean for this message (no facility lost or doubled)", () => {
    expect(trip.warnings).toEqual([]);
    expect(trip.tasks).toHaveLength(5);
    expect(trip.brokerName).toBe("ITS Logistics LLC");
    expect(trip.brokerReference).toBe("5113964");
  });
  it("create_load args: Seminole is the headline delivery on 2026-11-12, lot-to stays a stop", () => {
    const args = tripToCreateLoadArgs(trip)!;
    expect(args).toMatchObject({
      origin: "Panama City, FL", destination: "Seminole, OK", trip_number: "1874",
      broker_reference: "5113964", pickup_date: "2026-11-10", delivery_date: "2026-11-12",
      pickup_window_start: "2026-11-10T14:00:00.000Z", pickup_window_end: "2026-11-10T22:00:00.000Z",
      delivery_window_start: "2026-11-12T18:00:00.000Z",
    });
    expect((args.stops as unknown[]).length).toBe(3);
    expect(args.miles).toBe(1178);
  });
});

describe("parseDispatchTrip - unnumbered legs under other wordings", () => {
  it("a DROP AT leg still yields all its stops (the guard is structural, not a LOT TO string)", () => {
    const t = parseDispatchTrip(`NEW TRIP 55 HAS BEEN ASSIGNED
STOP 1
SHIPPER/CONSIGNEE: Alpha Plant
ADDRESS: 1 Alpha Way, Dallas, TX 75001
APPT: 12/01/2026 08:00 CST
TYPE: Pickup Stop
STOP 2
SHIPPER/CONSIGNEE: Beta Warehouse
ADDRESS: 2 Beta Road, Tulsa, OK 74101
APPT: 12/02/2026 09:00 CST
TYPE: Delivery Stop
DROP AT
SHIPPER/CONSIGNEE: Alpha Plant
ADDRESS: 1 Alpha Way, Dallas, TX 75001
APPT: 12/04/2026 09:00 CST
TYPE: Delivery Stop`)!;
    expect(t.stops).toHaveLength(3);
    expect(t.stops[2]!.header).toBe("DROP AT");
    expect(tripToCreateLoadArgs(t)).toMatchObject({ destination: "Tulsa, OK", delivery_date: "2026-12-02" });
  });
  it("a second facility under one STOP header starts its own stop instead of overwriting", () => {
    const t = parseDispatchTrip(`NEW TRIP 56 HAS BEEN ASSIGNED
STOP 1
SHIPPER/CONSIGNEE: Alpha Plant
ADDRESS: 1 Alpha Way, Dallas, TX 75001
APPT: 12/01/2026 08:00 CST
TYPE: Pickup Stop
SHIPPER/CONSIGNEE: Beta Warehouse
ADDRESS: 2 Beta Road, Tulsa, OK 74101
APPT: 12/02/2026 09:00 CST
TYPE: Delivery Stop`)!;
    expect(t.stops).toHaveLength(2);
    expect(t.stops[0]!.name).toBe("Alpha Plant");
    expect(t.stops[1]!.name).toBe("Beta Warehouse");
    expect(t.warnings.length).toBeGreaterThan(0);
  });
  it("a short-form window (08:00-16:00 with one zone) parses its end on the same date", () => {
    const t = parseDispatchTrip(`NEW TRIP 57 HAS BEEN ASSIGNED
STOP 1
SHIPPER/CONSIGNEE: Alpha Plant
ADDRESS: 1 Alpha Way, Dallas, TX 75001
APPT: 12/01/2026 08:00-16:00 CST
TYPE: Pickup Stop
STOP 2
SHIPPER/CONSIGNEE: Beta Warehouse
ADDRESS: 2 Beta Road, Tulsa, OK 74101
APPT: 12/02/2026 09:00 CST
TYPE: Delivery Stop`)!;
    expect(t.stops[0]!.appointmentAt).toBe("2026-12-01T14:00:00.000Z");
    expect(t.stops[0]!.appointmentEndAt).toBe("2026-12-01T22:00:00.000Z");
  });
});
