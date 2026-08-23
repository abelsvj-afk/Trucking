import type { Metadata } from "next";
import TrucksListView from "./view";

export const metadata: Metadata = { title: "Trucks — Trucking OS" };

export default function TrucksListPage() {
  return <TrucksListView />;
}
