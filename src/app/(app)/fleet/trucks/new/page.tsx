import type { Metadata } from "next";
import NewTruckView from "./view";

export const metadata: Metadata = { title: "Add truck — Trucking OS" };

export default function NewTruckPage() {
  return <NewTruckView />;
}
