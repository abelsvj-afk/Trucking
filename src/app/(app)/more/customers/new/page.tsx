import type { Metadata } from "next";
import NewCustomerView from "./view";

export const metadata: Metadata = { title: "Add customer — Trucking OS" };

export default function NewCustomerPage() {
  return <NewCustomerView />;
}
