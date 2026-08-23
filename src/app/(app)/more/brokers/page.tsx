import type { Metadata } from "next";
import BrokersListView from "./view";

export const metadata: Metadata = { title: "Brokers — Trucking OS" };

export default function BrokersListPage() {
  return <BrokersListView />;
}
