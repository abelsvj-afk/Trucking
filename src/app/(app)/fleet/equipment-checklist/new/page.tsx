import type { Metadata } from "next";
import NewEquipmentChecklistItemView from "./view";

export const metadata: Metadata = { title: "Add checklist item — Trucking OS" };

export default function NewEquipmentChecklistItemPage() {
  return <NewEquipmentChecklistItemView />;
}
