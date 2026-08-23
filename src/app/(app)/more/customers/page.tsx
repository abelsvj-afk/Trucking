import type { Metadata } from "next";
import CustomersListView from "./view";

export const metadata: Metadata = { title: "Customers — Trucking OS" };

export default function CustomersListPage() {
  return <CustomersListView />;
}
