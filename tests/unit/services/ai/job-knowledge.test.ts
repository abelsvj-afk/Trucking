// Abel Job Brain (§12). The job-knowledge module is the coaching
// source AND the pay advisor's bands - these tests pin that the
// brief the prompt renders is assembled from the same constants
// (so the two can never drift), and that the safety-critical
// coaching content is actually present.

import { describe, expect, it } from "vitest";
import {
  JOB_KNOWLEDGE_AS_OF,
  JOB_KNOWLEDGE_BRIEF,
  LOAD_LIFECYCLE,
  PAPERWORK_GUIDES,
  PAY_BANDS,
  PAY_STRUCTURE_GUIDE,
  renderJobKnowledgeBrief,
} from "@/services/ai/job-knowledge";

describe("job knowledge", () => {
  it("renders the brief from the same PAY_BANDS constants the advisor grades against", () => {
    const brief = renderJobKnowledgeBrief();
    expect(brief).toBe(JOB_KNOWLEDGE_BRIEF);
    expect(brief).toContain(JOB_KNOWLEDGE_AS_OF);
    expect(brief).toContain(`$${PAY_BANDS.effectiveCpmAllMiles.weakBelow.toFixed(2)}`);
    expect(brief).toContain(`$${PAY_BANDS.effectiveCpmAllMiles.strongAbove.toFixed(2)}`);
    expect(brief).toContain(`${PAY_BANDS.percentageOfGross.fairFrom}-${PAY_BANDS.percentageOfGross.strongAbove}%`);
    expect(PAY_BANDS.asOf).toBe(JOB_KNOWLEDGE_AS_OF);
  });

  it("carries the W2 vs 1099 math with the statutory rates", () => {
    const guide = PAY_STRUCTURE_GUIDE.join(" ");
    expect(guide).toMatch(/15\.3%/);
    expect(guide).toMatch(/92\.35%/);
    expect(guide).toMatch(/workers' comp/);
    expect(JOB_KNOWLEDGE_BRIEF).toMatch(/loaded miles only/i);
  });

  it("covers the full paperwork set, each with checks and a photograph rule", () => {
    const names = PAPERWORK_GUIDES.map((guide) => guide.document);
    expect(names.join(" ")).toMatch(/Bill of lading/);
    expect(names.join(" ")).toMatch(/Rate confirmation/);
    expect(names.join(" ")).toMatch(/Scale ticket/);
    expect(names.join(" ")).toMatch(/Lumper receipt/);
    expect(names.join(" ")).toMatch(/Settlement statement/);
    for (const guide of PAPERWORK_GUIDES) {
      expect(guide.checkBeforeSigning.length).toBeGreaterThan(0);
      expect(guide.photograph.length).toBeGreaterThan(0);
      expect(guide.pitfalls.length).toBeGreaterThan(0);
    }
    // The seal check is THE safety-critical BOL line.
    const bol = PAPERWORK_GUIDES.find((guide) => guide.document.startsWith("Bill of lading"))!;
    expect(bol.checkBeforeSigning.join(" ")).toMatch(/Seal number/);
  });

  it("walks the whole load lifecycle from offer to settlement", () => {
    const lifecycle = LOAD_LIFECYCLE.join(" ");
    expect(LOAD_LIFECYCLE.length).toBeGreaterThanOrEqual(8);
    expect(lifecycle).toMatch(/Rate confirmation/);
    expect(lifecycle).toMatch(/Settlement/);
    expect(JOB_KNOWLEDGE_BRIEF).toMatch(/Seal mismatch/);
    expect(JOB_KNOWLEDGE_BRIEF).toMatch(/Refused freight/);
  });
});
