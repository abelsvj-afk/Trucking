"use client";

// Task 2.3 (TASKS.md), per docs/design/ui-ux.md's Account/Settings section.
// Sign-in only, deliberately no "create account" link: docs/governance.md's
// single-admin access model has no open-signup workflow - an account is
// provisioned directly, not self-served.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/services/db/client";
import { usePageTitle } from "@/lib/use-page-title";

export default function LoginPage() {
  usePageTitle("Sign in");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrorDetails(null);
    setSubmitting(true);

    // A real bug this try/catch fixes: with no error handling here,
    // createClient() throwing (e.g. a missing/misconfigured
    // NEXT_PUBLIC_SUPABASE_* value - createBrowserClient rejects an
    // invalid URL synchronously) or signInWithPassword rejecting instead
    // of resolving with an .error field both left this async function
    // never reaching setSubmitting(false) - the button stayed disabled
    // ("Signing in…") forever with no feedback, and the request may
    // never even have reached Supabase. Silent hangs like that are
    // exactly what CLAUDE.md's "silent failures are prohibited" rule
    // and docs/design/ui-ux.md's Errors section exist to prevent.
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        // Never surface the raw provider error, per docs/design/ui-ux.md's
        // Errors section - a plain, actionable message instead.
        setError("Couldn't sign in. Check your email and password and try again.");
        return;
      }

      router.push("/");
      router.refresh();
    } catch (err) {
      setError("Couldn't reach the server. Check your connection and try again.");
      // The generic message above is what docs/design/ui-ux.md's Errors
      // section requires by default - never raw exception text to the
      // user. This is the doc's own named exception: "only in a
      // collapsed 'details' affordance, the error code - useful for you
      // to report a bug, invisible otherwise." The owner has no
      // dev-tools access on their phone, so this is the only way to see
      // what's actually failing without a laptop.
      setErrorDetails(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      setSubmitting(false);
    }
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

        {error && (
          <p role="alert">
            {error}
            {errorDetails && (
              <details>
                <summary>Details</summary>
                <p>{errorDetails}</p>
              </details>
            )}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
