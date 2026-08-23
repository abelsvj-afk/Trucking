import type { Metadata } from "next";
import LoginView from "./view";

export const metadata: Metadata = { title: "Sign in — Trucking OS" };

export default function LoginPage() {
  return <LoginView />;
}
