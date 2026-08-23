import type { Metadata } from "next";
import NewMaintenanceScheduleView from "./view";

export const metadata: Metadata = { title: "Add schedule item — Trucking OS" };

export default function NewMaintenanceSchedulePage() {
  return <NewMaintenanceScheduleView />;
}
