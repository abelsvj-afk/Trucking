import type { Metadata } from "next";
import NewMaintenanceEventView from "./view";

export const metadata: Metadata = { title: "Add maintenance event — Trucking OS" };

export default function NewMaintenanceEventPage() {
  return <NewMaintenanceEventView />;
}
