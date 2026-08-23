import type { Metadata } from "next";
import ForgotPasswordView from "./view";

export const metadata: Metadata = { title: "Reset password — Trucking OS" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordView />;
}
