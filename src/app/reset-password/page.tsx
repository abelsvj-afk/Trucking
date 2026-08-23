import type { Metadata } from "next";
import ResetPasswordView from "./view";

export const metadata: Metadata = { title: "Set new password — Trucking OS" };

export default function ResetPasswordPage() {
  return <ResetPasswordView />;
}
