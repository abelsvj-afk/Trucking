// Scoped tool catalogs: a bot cannot call what it cannot see.
// The completeness tests fail the build until a new Abel tool is
// classified — a new capability never leaks into a bot's turn by
// default. The catalog is built from the real registry
// (buildBotTools) against a dummy client: construction makes no
// network calls, and no tool is ever run here.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createBotStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import {
  botProposeTools,
  PROPOSE_TOOL_KINDS,
  READ_TOOL_GROUPS,
  scopedToolCatalog,
  toolGroupOf,
} from "@/services/bots/scoped-tools";
import { BOT_SLUGS } from "@/services/bots/registry";

const store = createBotStore(createClient("https://example.supabase.co", "test-key"), "company-1", "telegram");
const registry = buildBotTools(store);
const registryNames = new Set(registry.map((tool) => tool.name));
const reads = registry.filter((tool) => tool.access === "read");

const ABEL_ONLY = Object.entries(READ_TOOL_GROUPS)
  .filter(([, group]) => group === "abel-only")
  .map(([name]) => name);

describe("scoped tool catalogs", () => {
  it("classifies every read tool in Abel's registry — fail closed", () => {
    // 81 reads: the audit's 79, plus check_route (verified read),
    // plus list_malik_call_reports (PR #98, Malik call reports).
    expect(reads).toHaveLength(81);
    for (const tool of reads) {
      expect(toolGroupOf(tool.name)).not.toBeNull();
    }
  });

  it("has no stale classifications — every classified name is a real registry tool", () => {
    for (const name of Object.keys(READ_TOOL_GROUPS)) {
      expect(registryNames.has(name)).toBe(true);
    }
  });

  it("never offers a write tool in a group turn", () => {
    for (const slug of BOT_SLUGS) {
      for (const tool of scopedToolCatalog(store, slug)) {
        expect(tool.access).toBe("read");
      }
    }
  });

  it("never offers an abel-only tool to any group bot", () => {
    for (const slug of BOT_SLUGS) {
      const names = scopedToolCatalog(store, slug).map((tool) => tool.name);
      for (const abelOnly of ABEL_ONLY) {
        expect(names).not.toContain(abelOnly);
      }
    }
  });

  it("gives the Auditor every read group, and the Watchdog no maps", () => {
    const auditor = scopedToolCatalog(store, "auditor").map((tool) => tool.name);
    for (const one of ["list_loads", "hos_summary", "money_summary", "list_documents", "email_inbox", "list_facilities"]) {
      expect(auditor).toContain(one);
    }
    const watchdog = scopedToolCatalog(store, "compliance-watchdog").map((tool) => tool.name);
    expect(watchdog).not.toContain("list_facilities");
    expect(watchdog).not.toContain("check_route");
  });

  it("gives Maintenance maps, Tracker email, and Scout loads + maps", () => {
    const maintenance = scopedToolCatalog(store, "maintenance").map((tool) => tool.name);
    expect(maintenance).toContain("list_facilities");
    expect(maintenance).toContain("check_route");
    const tracker = scopedToolCatalog(store, "tracker").map((tool) => tool.name);
    expect(tracker).toContain("email_inbox");
    const scout = scopedToolCatalog(store, "dispatch-scout").map((tool) => tool.name);
    expect(scout).toContain("list_loads");
    expect(scout).toContain("check_route");
  });

  it("gives every bot a non-empty catalog", () => {
    for (const slug of BOT_SLUGS) {
      expect(scopedToolCatalog(store, slug).length).toBeGreaterThan(0);
    }
  });

  it("gives each bot only its own propose tools, all staged-never-executed", () => {
    const names = (slug: (typeof BOT_SLUGS)[number]) => botProposeTools(slug).map((tool) => tool.name);
    expect(names("dispatch-scout").sort()).toEqual(["propose_load_draft", "propose_message", "propose_shortlist"].sort());
    expect(names("tracker").sort()).toEqual(["propose_message", "propose_status_update"].sort());
    expect(names("maintenance").sort()).toEqual(["propose_message", "propose_work_order"].sort());
    expect(names("billing").sort()).toEqual(["propose_invoice", "propose_message"].sort());
    expect(names("abel")).toEqual(["propose_message"]);
    expect(names("compliance-watchdog")).toEqual([]);
    expect(names("auditor")).toEqual([]);
    for (const slug of BOT_SLUGS) {
      for (const tool of botProposeTools(slug)) {
        expect(tool.access).toBe("write");
        expect(tool.alwaysPropose).toBe(true);
        expect(PROPOSE_TOOL_KINDS[tool.name]).toBeDefined();
      }
    }
  });
});
