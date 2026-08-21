"use client";

// Task 2.3 (TASKS.md), per docs/design/ui-ux.md's Account/Settings section.
// Sign-in only, deliberately no "create account" link: docs/governance.md's
// single-admin access model has no open-signup workflow - an account is
// provisioned directly, not self-served.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/services/db/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setSubmitting(false);

    if (signInError) {
      // Never surface the raw provider error, per docs/design/ui-ux.md's
      // Errors section - a plain, actionable message instead.
      setError("Couldn't sign in. Check your email and password and try again.");
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoComplete="current-password"
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
