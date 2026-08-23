import type { Metadata } from "next";
import AccountSettingsView from "./view";

export const metadata: Metadata = { title: "Settings — Trucking OS" };

export default function AccountSettingsPage() {
  return <AccountSettingsView />;
}
