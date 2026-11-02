import { describe, expect, it } from "vitest";
import { fetchGdeltArticles, type GdeltArticle } from "@/services/integrations/gdelt";
import { getResearchConfig } from "@/services/research/config";
import { sourceWeight, topicConvergenceScore } from "@/services/research/scoring";
import { evaluateTriggers, signalCrossesThreshold, type CompanyRunHistory } from "@/services/research/triggers";
import {
  buildTechSignals,
  classifyTechSubthemes,
  hasDeploymentEvidence,
  TECH_QUERY_SETS,
} from "@/services/research/watchers/gdelt-tech";
import type { PressureSignal } from "@/services/research/watchers/types";

const config = getResearchConfig({} as NodeJS.ProcessEnv);
const OBSERVED = "2026-10-31T12:00:00Z";
const NOW = new Date(OBSERVED);

const articles = (titles: string[]): GdeltArticle[] =>
  titles.map((title, i) => ({ title, url: `https://x.example/${i}`, domain: "x.example", seenDate: "20261031T000000Z" }));

const prTitles = (n: number) =>
  Array.from({ length: n }, (_, i) => `Vendor ${i} launches new autonomous truck AI platform for fleets`);
const deploymentTitles = (n: number) =>
  Array.from({ length: n }, (_, i) => `Carrier ${i} begins hauling freight with driverless trucks in Texas`);

describe("GDELT query support (fetchGdeltArticles)", () => {
  it("sends a caller-supplied query set to the API", async () => {
    let seenQuery: string | null = null;
    const fetchFn = async (input: RequestInfo | URL) => {
      seenQuery = new URL(String(input)).searchParams.get("query");
      return new Response(JSON.stringify({ articles: [] }), { status: 200 });
    };
    const techSet = TECH_QUERY_SETS.find((s) => s.subtheme === "autonomous_trucking");
    await fetchGdeltArticles("48h", 75, fetchFn as typeof fetch, techSet?.query);
    expect(seenQuery).toBe(techSet?.query);
    expect(TECH_QUERY_SETS.map((s) => s.subtheme)).toEqual([
      "autonomous_trucking",
      "ai_logistics",
      "warehouse_robotics",
      "general_ai",
    ]);
  });
});

describe("tech classification (classifyTechSubthemes / hasDeploymentEvidence)", () => {
  it("sorts headlines into subthemes; AI alone is general, AI + logistics words is both", () => {
    expect(classifyTechSubthemes("Driverless trucks roll out in Texas")).toContain("autonomous_trucking");
    expect(classifyTechSubthemes("New AI dispatch tool cuts empty miles for fleets")).toEqual(
      expect.arrayContaining(["ai_logistics", "general_ai"]),
    );
    expect(classifyTechSubthemes("New generative AI model released")).toEqual(["general_ai"]);
    expect(classifyTechSubthemes("Warehouse robotics startup expands fulfillment network")).toContain(
      "warehouse_robotics",
    );
    expect(classifyTechSubthemes("Local bake sale raises money")).toEqual([]);
  });

  it("deployment evidence is real-world or regulatory, not announcement language", () => {
    expect(hasDeploymentEvidence("Fleet begins hauling freight without a safety driver")).toBe(true);
    expect(hasDeploymentEvidence("FMCSA grants exemption for driverless operations")).toBe(true);
    expect(hasDeploymentEvidence("Vendor launches new autonomous truck AI platform")).toBe(false);
    expect(hasDeploymentEvidence("Startup unveils warehouse robotics concept")).toBe(false);
  });
});

describe("tech bursts (buildTechSignals)", () => {
  it("bursts per subtheme at the floor on topic technology, with per-subtheme dedupe", () => {
    const signals = buildTechSignals(articles(deploymentTitles(4)), config, OBSERVED);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.watcherKey).toBe("gdelt_tech");
    expect(signals[0]?.kind).toBe("tech_burst");
    expect(signals[0]?.topic).toBe("technology");
    expect(signals[0]?.data).toMatchObject({ itemCount: 4, deploymentCount: 4, subtheme: "autonomous_trucking" });
    expect(signals[0]?.dedupeKey).toBe("tech_burst:autonomous_trucking:2026-10-31");
    expect(signals[0]?.summary).toContain("real-world deployment or regulatory action");
  });

  it("below the burst floor there is no signal at all", () => {
    expect(buildTechSignals(articles(deploymentTitles(3)), config, OBSERVED)).toEqual([]);
  });

  it("deployment evidence weighs more than announcements at the same cluster size", () => {
    const pr = buildTechSignals(articles(prTitles(10)), config, OBSERVED);
    const deployed = buildTechSignals(articles(deploymentTitles(10)), config, OBSERVED);
    expect(deployed[0]?.magnitude).toBeGreaterThan(pr[0]?.magnitude ?? 0);
    expect(pr[0]?.data.deploymentCount).toBe(0);
    expect(pr[0]?.summary).toContain("no deployment or regulatory action reported");
  });
});

describe("tech trigger discipline (signalCrossesThreshold / convergence)", () => {
  const techSignal = (data: Record<string, unknown>, magnitude = 0.9): PressureSignal => ({
    watcherKey: "gdelt_tech",
    kind: "tech_burst",
    topic: "technology",
    magnitude,
    summary: "s",
    items: [],
    data,
    dedupeKey: "tech-1",
    observedAt: OBSERVED,
  });

  it("a vendor press-release pile never hard-fires alone, however large", () => {
    expect(signalCrossesThreshold(techSignal({ itemCount: 60, deploymentCount: 0 }), config)).toBe(false);
  });

  it("a large cluster with real deployment evidence hard-fires", () => {
    expect(
      signalCrossesThreshold(
        techSignal({ itemCount: config.techHardMinItems, deploymentCount: config.techHardMinDeployment }),
        config,
      ),
    ).toBe(true);
    expect(signalCrossesThreshold(techSignal({ itemCount: config.techHardMinItems, deploymentCount: 1 }), config)).toBe(
      false,
    );
    expect(signalCrossesThreshold(techSignal({ itemCount: 10, deploymentCount: 9 }), config)).toBe(false);
  });

  it("scores as a weak news source, and one burst alone can never reach the convergence fire line", () => {
    expect(sourceWeight("gdelt_tech")).toBe(0.6);
    const lone = techSignal({ itemCount: 30, deploymentCount: 0 }, 1);
    expect(topicConvergenceScore([lone], "technology", NOW, config)).toBeLessThan(config.convergenceFireScore);

    const history: CompanyRunHistory = { lastBaselineRunAt: OBSERVED, runsToday: 0, runsThisMonth: 0 };
    const decisions = evaluateTriggers({ now: NOW, history, freshSignals: [lone], config });
    expect(decisions.filter((d) => d.topic === "technology")).toEqual([]);
  });

  it("distinct sources converging on technology do fire (none of them hard-fires)", () => {
    const history: CompanyRunHistory = { lastBaselineRunAt: OBSERVED, runsToday: 0, runsThisMonth: 0 };
    const fresh: PressureSignal[] = [
      // Tech burst: big, but announcement-only, so convergence-only.
      techSignal({ itemCount: 30, deploymentCount: 0 }, 1),
      // Geo burst below its solo floor.
      { ...techSignal({}, 0.9), watcherKey: "gdelt_geo", kind: "geo_burst", data: { itemCount: 6 }, dedupeKey: "geo-tech" },
      // A federal-register item below its hard magnitude.
      {
        ...techSignal({}, 0.7),
        watcherKey: "federal_register",
        kind: "federal_rule_proposed",
        dedupeKey: "fed-tech",
      },
    ];
    for (const s of fresh) expect(signalCrossesThreshold(s, config)).toBe(false);
    const decisions = evaluateTriggers({ now: NOW, history, freshSignals: fresh, config });
    const tech = decisions.find((d) => d.topic === "technology");
    expect(tech?.kind).toBe("pressure");
    expect(tech?.reason).toContain("Convergence");
  });
});
