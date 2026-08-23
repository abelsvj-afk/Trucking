import type { Metadata } from "next";
import NewFuelPurchaseView from "./view";

export const metadata: Metadata = { title: "Add fuel purchase — Trucking OS" };

export default function NewFuelPurchasePage() {
  return <NewFuelPurchaseView />;
}
