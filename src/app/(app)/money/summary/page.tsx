import type { Metadata } from "next";
import FinancialSummaryView from "./view";

export const metadata: Metadata = { title: "Financial summary — Trucking OS" };

export default function FinancialSummaryPage() {
  return <FinancialSummaryView />;
}
