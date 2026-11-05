import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appDir = path.resolve(process.cwd(), "src/app");

describe("globals.css is the ordered index of ./styles", () => {
  it("imports every part, in filename order, and nothing else", () => {
    const parts = readdirSync(path.join(appDir, "styles")).filter((f) => f.endsWith(".css")).sort();
    const imported = [...readFileSync(path.join(appDir, "globals.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((m) => m[1]);
    expect(imported).toEqual(parts);
  });
});
