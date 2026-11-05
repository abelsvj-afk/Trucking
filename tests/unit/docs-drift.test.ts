// Wave 4 drift checks (audit closure checklist, docs/reconciliation/wave-4-test-matrix.md §4):
// the reconciliation documents must not silently fall behind the code again.
// Each fails with the exact missing name, so the fix is one line in the named doc.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBotTools } from "@/services/bot/tools";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("docs drift", () => {
  it("every API route file is in the api-contracts route inventory", () => {
    const doc = read("docs/api-contracts.md");
    const routes = walk(path.join(root, "src/app/api"))
      .filter((f) => f.endsWith("route.ts"))
      .map((f) => "/" + path.relative(path.join(root, "src/app"), f).replace(/\/route\.ts$/, ""));
    const missing = routes.filter((r) => !doc.includes(`\`${r}\``));
    expect(missing, `add these routes to the inventory table in docs/api-contracts.md`).toEqual([]);
  });

  it("every table a migration creates is described in schemas.md", () => {
    const doc = read("docs/schemas.md");
    const tables = new Set<string>();
    for (const f of readdirSync(path.join(root, "supabase/migrations")).filter((n) => n.endsWith(".sql"))) {
      const sql = read(`supabase/migrations/${f}`).replace(/--[^\n]*/g, "");
      for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)\s*\(/gi)) tables.add(m[1]!);
    }
    const missing = [...tables].filter((t) => !new RegExp(`(^|[^a-z_])${t}([^a-z_]|$)`).test(doc));
    expect(missing, `add these tables to docs/schemas.md`).toEqual([]);
  });

  it("every Abel tool is in the authority matrix registry", () => {
    const doc = read("docs/ai-authority-matrix.md");
    const store = { client: {}, companyId: "c", channel: "telegram" } as never;
    const missing = buildBotTools(store).map((t) => t.name).filter((n) => !doc.includes(`\`${n}\``));
    expect(missing, `add these tools to docs/ai-authority-matrix.md §6`).toEqual([]);
  });

  it("every capability with a kill switch appears in the authority matrix", () => {
    const doc = read("docs/ai-authority-matrix.md");
    const src = read("src/data/schemas/ai-settings.ts");
    const labels = read("src/app/(app)/more/settings/page.tsx");
    const keys = [...labels.matchAll(/^\s{2}([a-z_]+): "/gm)].map((m) => m[1]!).filter((k) => src.length > 0 && k.length > 3);
    const missing = keys.filter((k) => !doc.includes(`\`${k}\``));
    expect(missing, `add these capabilities to docs/ai-authority-matrix.md §2`).toEqual([]);
  });
});
