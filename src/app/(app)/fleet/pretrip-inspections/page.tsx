import type { Metadata } from "next";
import PretripInspectionsView from "./view";

export const metadata: Metadata = { title: "Pre-trip inspections — Trucking OS" };

export default function PretripInspectionsPage() {
  return <PretripInspectionsView />;
}
