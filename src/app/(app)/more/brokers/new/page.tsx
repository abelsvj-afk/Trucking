import type { Metadata } from "next";
import NewBrokerView from "./view";

export const metadata: Metadata = { title: "Add broker — Trucking OS" };

export default function NewBrokerPage() {
  return <NewBrokerView />;
}
