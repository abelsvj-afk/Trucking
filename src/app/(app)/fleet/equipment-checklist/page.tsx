import type { Metadata } from "next";
import EquipmentChecklistView from "./view";

export const metadata: Metadata = { title: "Equipment checklist — Trucking OS" };

export default function EquipmentChecklistPage() {
  return <EquipmentChecklistView />;
}
