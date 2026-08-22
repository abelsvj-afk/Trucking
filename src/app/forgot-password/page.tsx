"use client";

// Account recovery, added per the owner's explicit request - previously
// there was no way to regain access after a forgotten password. Sign-in
// itself deliberately has no self-serve signup (docs/governance.md's
// single-admin model) - this is a different thing: the same admin
// regaining their own existing access, not creating a new one.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/services/db/client";
import { usePageTitle } from "@/lib/use-page-title";

export default function ForgotPasswordPage() {
  usePageTitle("Reset password");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const supabase = createClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email);

      // Supabase's own resetPasswordForEmail already never reveals
      // whether the address matches an account - success is returned
      // either way, by design, specifically to prevent enumeration at
      // the API level. A real error here (rate limit, malformed
      // request, network/service failure) is therefore safe to surface
      // without leaking anything - swallowing it too would violate
      // CLAUDE.md's "silent failures are prohibited" for no security
      // benefit, since account existence was never at stake in this
      // branch to begin with. Caught directly by testing this screen,
      // not assumed: the first version of this handler discarded the
      // return value entirely and always showed success.
      if (resetError) {
        setError("Couldn't send the reset link. Try again.");
        return;
      }

      setSubmitted(true);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main>
        <h1>Reset password</h1>
        <p role="status">
          If an account exists for {email}, we&rsquo;ve sent a link to reset the password. Check your
          email.
        </p>
        <Link href="/login">Back to sign in</Link>
      </main>
    );
  }

  return (
    <main>
      <h1>Reset password</h1>
      <p>Enter the email on your account and we&rsquo;ll send a link to set a new password.</p>
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

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Sending…" : "Send reset link"}
        </button>
      </form>
      <Link href="/login">Back to sign in</Link>
    </main>
  );
}
