// The app's single money formatter (owner decision 2026-11-12): commas,
// two decimals, minus sign before the dollar sign.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatMoney } from "@/lib/money-format";

describe("formatMoney", () => {
  it("uses thousands separators and always two decimals", () => {
    expect(formatMoney(103400)).toBe("$1,034.00");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(99999)).toBe("$999.99");
    expect(formatMoney(100000)).toBe("$1,000.00");
    expect(formatMoney(123456789)).toBe("$1,234,567.89");
  });

  it("puts the minus sign before the dollar sign", () => {
    expect(formatMoney(-56894)).toBe("-$568.94");
    expect(formatMoney(-120000)).toBe("-$1,200.00");
    expect(formatMoney(-1)).toBe("-$0.01");
  });

  it("changes no amount: the digits are exactly what cents/100 to two places gives", () => {
    for (const cents of [0, 1, 49, 50, 99, 100, 20950, 35944, 103400, 2000000, -40000, -56894]) {
      const digits = formatMoney(cents).replace(/[$,-]/g, "");
      expect(digits).toBe((Math.abs(cents) / 100).toFixed(2));
    }
  });

  it("never prints $NaN or a minus zero", () => {
    expect(formatMoney(Number.NaN)).toBe("—");
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatMoney(-0)).toBe("$0.00");
    expect(formatMoney(-0.4)).toBe("$0.00");
  });
});

describe("app pages and components use the shared formatter", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(join(process.cwd(), "src/app/(app)"));
  walk(join(process.cwd(), "src/components"));
  // Business Credit is another lane's page and adopts the formatter itself.
  const mine = files.filter((f) => !f.includes("business-credit"));

  it("no page or component builds a dollar string from cents by hand", () => {
    const offenders = mine.filter((f) => /`[^`]*\$\$\{\([^`}]*\/ 100\)\.to(Fixed|LocaleString)/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.replace(process.cwd(), ""))).toEqual([]);
  });

  it("no page or component imports the older lib formatters", () => {
    const offenders = mine.filter((f) =>
      /import \{[^}]*\b(formatCents|formatDollars)\b[^}]*\} from "@\/lib\/(pay-projection|truck-fund)"/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => f.replace(process.cwd(), ""))).toEqual([]);
  });
});
