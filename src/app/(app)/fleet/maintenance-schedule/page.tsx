import type { Metadata } from "next";
import MaintenanceScheduleView from "./view";

export const metadata: Metadata = { title: "Maintenance schedule — Trucking OS" };

export default function MaintenanceSchedulePage() {
  return <MaintenanceScheduleView />;
}
