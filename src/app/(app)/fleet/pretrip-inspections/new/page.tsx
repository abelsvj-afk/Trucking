import type { Metadata } from "next";
import NewPretripInspectionView from "./view";

export const metadata: Metadata = { title: "Log inspection — Trucking OS" };

export default function NewPretripInspectionPage() {
  return <NewPretripInspectionView />;
}
