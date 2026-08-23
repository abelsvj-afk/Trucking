import type { Metadata } from "next";
import MaintenanceEventsListView from "./view";

export const metadata: Metadata = { title: "Maintenance — Trucking OS" };

export default function MaintenanceEventsListPage() {
  return <MaintenanceEventsListView />;
}
