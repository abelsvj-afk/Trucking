// Timezone transitions (owner order 2026-11-11): the display zone is
// derived from the truck's latest position, home Eastern is the
// fallback, and every user-facing time carries an explicit zone label.
// TZ-A: the same instant renders CT before a Central->Eastern crossing
// and ET after, labeled both times. TZ-C: a delivery appointment
// renders in the PLACE's zone. TZ-D: no rendered string carries a raw
// UTC timestamp.

import { describe, expect, it } from "vitest";
import {
  DISPLAY_ZONE_FRESH_MS,
  formatAppointment,
  formatClock,
  formatDateTime,
  HOME_TIME_ZONE,
  resolveDisplayZone,
  timeZoneForPosition,
  zoneCrossingNotice,
  zoneShortLabel,
} from "@/lib/display-zone";

// 2026-11-08T13:40:37.858Z — the pending duty proposal from the night
// of the incident: 8:40 AM ET / 7:40 AM CT on Nov 8 (DST ended Nov 1).
const INCIDENT_ISO = "2026-11-08T13:40:37.858Z";
const INCIDENT_MS = Date.parse(INCIDENT_ISO);

describe("timeZoneForPosition (lat/lng -> IANA zone, offline dataset)", () => {
  it("puts the truck in Central through Louisiana, Mississippi, Oklahoma", () => {
    expect(timeZoneForPosition(32.4648, -91.795)).toBe("America/Chicago"); // Rayville, LA — where he was that night
    expect(timeZoneForPosition(32.2988, -90.1848)).toBe("America/Chicago"); // Jackson, MS
    expect(timeZoneForPosition(35.23, -96.67)).toBe("America/Chicago"); // Seminole, OK
  });
  it("puts the Florida panhandle in Central and the peninsula in Eastern", () => {
    expect(timeZoneForPosition(30.16, -85.65)).toBe("America/Chicago"); // Panama City, FL
    expect(timeZoneForPosition(28.54, -81.38)).toBe("America/New_York"); // Orlando, FL
  });
  it("puts Atlanta in Eastern, El Paso in Mountain, Phoenix in Mountain", () => {
    expect(timeZoneForPosition(33.75, -84.39)).toBe("America/New_York");
    expect(timeZoneForPosition(31.76, -106.49)).toBe("America/Denver");
    expect(timeZoneForPosition(33.45, -112.07)).toBe("America/Phoenix");
  });
  it("falls back to home Eastern on an invalid fix, never throws", () => {
    expect(timeZoneForPosition(Number.NaN, -91.795)).toBe(HOME_TIME_ZONE);
    expect(timeZoneForPosition(32.46, Number.NaN)).toBe(HOME_TIME_ZONE);
    expect(timeZoneForPosition(91, 0)).toBe(HOME_TIME_ZONE);
  });
});

describe("zoneShortLabel", () => {
  it("uses the owner's own abbreviations, stable across DST", () => {
    expect(zoneShortLabel("America/New_York")).toBe("ET");
    expect(zoneShortLabel("America/Chicago")).toBe("CT");
    expect(zoneShortLabel("America/Denver")).toBe("MT");
    expect(zoneShortLabel("America/Phoenix")).toBe("MT");
    expect(zoneShortLabel("America/Los_Angeles")).toBe("PT");
    expect(zoneShortLabel("America/Anchorage")).toBe("AKT");
    expect(zoneShortLabel("Pacific/Honolulu")).toBe("HT");
  });
});

describe("formatClock / formatDateTime — every render labeled, never UTC", () => {
  it("renders the incident instant as 7:40 AM CT in Central", () => {
    expect(formatClock(INCIDENT_MS, "America/Chicago")).toBe("7:40 AM CT");
    expect(formatClock(INCIDENT_ISO, "America/Chicago")).toBe("7:40 AM CT");
  });
  it("renders the same instant as 8:40 AM ET in Eastern (TZ-A: one instant, two labels)", () => {
    expect(formatClock(INCIDENT_MS, "America/New_York")).toBe("8:40 AM ET");
  });
  it("a Central->Eastern crossing changes the label, not the instant", () => {
    const before = formatClock(INCIDENT_MS, "America/Chicago");
    const after = formatClock(INCIDENT_MS, "America/New_York");
    expect(before).not.toBe(after);
    expect(Date.parse(INCIDENT_ISO)).toBe(INCIDENT_MS);
  });
  it("never emits a raw UTC timestamp", () => {
    for (const zone of ["America/Chicago", "America/New_York", "America/Denver"]) {
      expect(formatClock(INCIDENT_MS, zone)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(formatDateTime(INCIDENT_MS, zone)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });
  it("formatDateTime carries the date and the label", () => {
    expect(formatDateTime("2026-11-12T18:00:00Z", "America/Chicago")).toBe("Nov 12, 2026, 12:00 PM CT");
    expect(formatDateTime("2026-11-12T18:00:00Z", "America/New_York")).toBe("Nov 12, 2026, 1:00 PM ET");
  });
});

describe("formatAppointment — the delivery renders in the PLACE's zone (TZ-C)", () => {
  it("a Seminole, OK delivery at noon CT reads noon CT, not 1 PM ET", () => {
    expect(formatAppointment("2026-11-12T18:00:00Z", "America/Chicago")).toBe("Nov 12, 12:00 PM CT");
  });
  it("an Atlanta delivery reads ET", () => {
    expect(formatAppointment("2026-11-12T18:00:00Z", "America/New_York")).toBe("Nov 12, 1:00 PM ET");
  });
  it("a stop with no recorded zone falls back to labeled home time, never unlabeled", () => {
    expect(formatAppointment("2026-11-12T18:00:00Z", null)).toBe("Nov 12, 1:00 PM ET");
    expect(formatAppointment("2026-11-12T18:00:00Z", "Not/AZone")).toBe("Nov 12, 1:00 PM ET");
  });
});

describe("resolveDisplayZone — position first, home on a stale or missing fix", () => {
  const now = Date.parse("2026-11-11T04:00:00Z");
  it("a fresh fix sets the display zone to the truck's zone", () => {
    const r = resolveDisplayZone({ lat: 32.4648, lng: -91.795, atMs: now - 5 * 60_000 }, now);
    expect(r).toEqual({ timeZone: "America/Chicago", label: "CT", source: "position" });
  });
  it("a fix older than the freshness window falls back to home", () => {
    const r = resolveDisplayZone(
      { lat: 32.4648, lng: -91.795, atMs: now - DISPLAY_ZONE_FRESH_MS - 1 },
      now,
    );
    expect(r).toEqual({ timeZone: HOME_TIME_ZONE, label: "ET", source: "home" });
  });
  it("no fix at all falls back to home", () => {
    expect(resolveDisplayZone(null, now)).toEqual({ timeZone: HOME_TIME_ZONE, label: "ET", source: "home" });
  });
});

describe("zoneCrossingNotice — said plainly once, not spammed", () => {
  it("names the new zone in words and in label", () => {
    expect(zoneCrossingNotice("America/Chicago", "America/New_York")).toBe(
      "Crossed into Eastern — times below are ET.",
    );
    expect(zoneCrossingNotice("America/New_York", "America/Chicago")).toBe(
      "Crossed into Central — times below are CT.",
    );
  });
  it("says nothing when the zone did not change", () => {
    expect(zoneCrossingNotice("America/Chicago", "America/Chicago")).toBeNull();
  });
});
