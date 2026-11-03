// Reliability Unit B (design B.2.1-B.2.3): the shared time plumbing.
//
// The F-011 regression (a UTC slice shown as a local pre-fill) is only
// observable in a non-UTC zone, and a vitest worker's zone is fixed at
// process start - so the zone-sensitive assertions run in a child Node
// process started with TZ=America/New_York (Node 24 type-stripping
// imports the helper directly). The remaining assertions are
// zone-agnostic by construction (explicit-zone formatting, validation,
// fallback reporting, and the local round-trip property).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  isValidTimeZone,
  localDateTimeInputValue,
  resolveViewerTimeZone,
  viewerTimeZone,
} from "@/lib/time";

describe("isValidTimeZone / resolveViewerTimeZone (B1, B.2.1)", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects non-zones and empty values", () => {
    expect(isValidTimeZone("Bogus/Zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("EST5EDT-ish")).toBe(false);
  });

  it("uses a valid supplied zone without fallback", () => {
    expect(resolveViewerTimeZone("America/Chicago")).toEqual({
      timeZone: "America/Chicago",
      usedFallback: false,
    });
  });

  it("falls back to America/New_York - visibly - on absence or garbage", () => {
    expect(resolveViewerTimeZone(null)).toEqual({
      timeZone: "America/New_York",
      usedFallback: true,
    });
    expect(resolveViewerTimeZone(undefined).usedFallback).toBe(true);
    expect(resolveViewerTimeZone("Bogus/Zone")).toEqual({
      timeZone: "America/New_York",
      usedFallback: true,
    });
  });

  it("viewerTimeZone reports the runtime's own zone", () => {
    expect(viewerTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("localDateTimeInputValue (B2, F-011)", () => {
  it("is shaped like a datetime-local value and round-trips through the local parser", () => {
    const instant = new Date("2026-03-05T14:07:00Z");
    const value = localDateTimeInputValue(instant);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // Parsing the input value back as local time lands on the same
    // instant (to the minute) - the form's save path relies on this.
    expect(new Date(value).getTime()).toBe(instant.getTime());
  });

  it("acceptance B.4.2 (child process, TZ=America/New_York): 8 PM ET pre-fills as 20:00 local that day", () => {
    const timeModuleUrl = pathToFileURL(
      join(process.cwd(), "src/lib/time.ts"),
    ).href;
    const driver = join(mkdtempSync(join(tmpdir(), "unit-b-time-")), "driver.mts");
    writeFileSync(
      driver,
      [
        `import { localDateTimeInputValue, viewerTimeZone } from ${JSON.stringify(timeModuleUrl)};`,
        `const instant = new Date("2026-01-15T01:00:00Z");`, // Jan 14, 8:00 PM ET
        `console.log(JSON.stringify({`,
        `  utcSlice: instant.toISOString().slice(0, 16),`,
        `  value: localDateTimeInputValue(instant),`,
        `  zone: viewerTimeZone(),`,
        `}));`,
      ].join("\n"),
    );
    const stdout = execFileSync("node", ["--experimental-strip-types", driver], {
      env: { ...process.env, TZ: "America/New_York" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(stdout.trim()) as { utcSlice: string; value: string; zone: string };
    expect(result.zone).toBe("America/New_York");
    expect(result.utcSlice).toBe("2026-01-15T01:00"); // the old defect's value
    expect(result.value).toBe("2026-01-14T20:00"); // the fixed pre-fill
  }, 20_000);
});

describe("formatDate / formatDateTime (B3, F-012)", () => {
  it("acceptance B.4.3: a 00:30 UTC purchase renders as the previous evening ET", () => {
    const stored = "2026-10-31T00:30:00Z"; // Oct 30, 8:30 PM America/New_York
    const rendered = formatDateTime(stored, "America/New_York");
    expect(rendered).toContain("Oct 30, 2026");
    expect(rendered).toContain("8:30 PM");
    expect(rendered).not.toContain("2026-10-31T00:30");
    expect(formatDate(stored, "America/New_York")).toBe("Oct 30, 2026");
  });

  it("renders in the explicitly named zone", () => {
    const stored = "2026-10-31T00:30:00Z"; // Oct 31, 12:30 AM in UTC
    expect(formatDate(stored, "UTC")).toBe("Oct 31, 2026");
  });

  it("never throws on an unparseable stored value", () => {
    expect(formatDateTime("not-a-timestamp", "America/New_York")).toBe("not-a-timestamp");
  });
});
