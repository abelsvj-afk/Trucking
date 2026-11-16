import { describe, expect, it } from "vitest";
import { parseDispatchTrip, tripToCreateLoadArgs } from "@/lib/dispatch-trip";

export const TRIP_1918 = `🚛 NEW TRIP 9918 HAS BEEN ASSIGNED

🏁 STOP 1
SHIPPER/CONSIGNEE: SAMPLE FEEDS
📍 ADDRESS: 200 Example Street Southeast , Ardmore, OK 73401
APPT: 11/16/2026 14:00 CST
TYPE: Pickup Stop

=======================

🏁 STOP 2
SHIPPER/CONSIGNEE: SAMPLE DC1
📍 ADDRESS: 3380 Example Avenue Road , Ocala, FL 34475
APPT: 11/18/2026 06:30 EST
TYPE: Delivery Stop

=======================

🧾 TRIP DETAILS

BROKER: Example Transportation Group
REF #: 1234567
DEADHEAD: 105.00 mi
LOADED DISTANCE: 1,118.10 mi
TOTAL DISTANCE: 1,223.10 mi

===================================
❗️Send Picture of trailer in PU/DEL
❗️SEND SEAL PICTURE
❗️SIGNED BOL - should be sent to the group.
✅ PLEASE CHECK AND CONFIRM`;

describe("a trip over 1,000 miles (owner 2026-11-16)", () => {
  it("parses with comma-grouped miles", () => {
    const trip = parseDispatchTrip(TRIP_1918);
    expect(trip).not.toBeNull();
    expect(trip!.loadedMiles).toBe(1118.1);
    expect(trip!.totalMiles).toBe(1223.1);
    expect(trip!.milesMismatch ?? null).toBeNull();
    const args = tripToCreateLoadArgs(trip!);
    expect(args!.origin).toBe("Ardmore, OK");
  });
});
