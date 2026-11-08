// The owner's standing rule: nothing user-facing is in the browser's or UTC's zone - everything is Eastern. This scans the UI source
// so an unqualified instant formatter cannot come back. Calendar-date strings built at noon (`...T12:00:00`) are zone-safe and exempt;
// plain number formatting is not a time.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("every user-facing instant is formatted in America/New_York", () => {
  const offenders: string[] = [];
  for (const file of [...walk("src/app"), ...walk("src/components")]) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/toLocale(Date|Time)?String\(/.test(line)) return;
      // the options object or the noon calendar-date string may sit on neighbouring lines
      if (/timeZone|T12:00:00/.test(lines.slice(Math.max(0, i - 2), i + 6).join("\n"))) return;
      if (/\.toLocaleString\((?:"en-US")?\)/.test(line) && /(miles|odometer|mileage|weight|lbs)/i.test(line)) return; // a number, not a time
      if (/\(cents|value\b.*\)\.toLocaleString|\.toLocaleString\("en-US", \{ minimumFraction/.test(line)) return;
      offenders.push(`${file}:${i + 1}`);
    });
  }
  it("has no browser-zone date/time formatting left", () => {
    expect(offenders).toEqual([]);
  });
});
