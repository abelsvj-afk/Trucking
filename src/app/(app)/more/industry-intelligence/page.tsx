import type { Metadata } from "next";
import IndustryIntelligenceView from "./view";

export const metadata: Metadata = { title: "Industry intelligence — Trucking OS" };

export default function IndustryIntelligencePage() {
  return <IndustryIntelligenceView />;
}
