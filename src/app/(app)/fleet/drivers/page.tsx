import type { Metadata } from "next";
import DriversListView from "./view";

export const metadata: Metadata = { title: "Drivers — Trucking OS" };

export default function DriversListPage() {
  return <DriversListView />;
}
