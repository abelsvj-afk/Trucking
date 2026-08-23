import type { Metadata } from "next";
import FuelPurchasesListView from "./view";

export const metadata: Metadata = { title: "Fuel purchases — Trucking OS" };

export default function FuelPurchasesListPage() {
  return <FuelPurchasesListView />;
}
