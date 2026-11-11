"use client";

import { useCallback, useEffect, useState } from "react";
import { usePageTitle } from "@/lib/use-page-title";
import { ApiClientError, apiClient } from "@/lib/api-client";
import { formatDate, formatDateTime } from "@/lib/time";
import {
  PAYMENT_STATE_LABELS,
  type BusinessCreditData,
} from "@/lib/business-credit";
import type { BusinessCreditAccount } from "@/types/entities";

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: BusinessCreditData };

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const SIGNAL_LABELS: Record<string, string> = {
  invoice: "Invoice seen in email",
  due_date: "Due date seen in email",
  payment_made: "Payment seen in email",
  missed: "Missed / late payment seen in email",
  update: "Update",
};

function AccountCard({ account }: { account: BusinessCreditAccount }) {
  const missed = account.payment_state === "missed";
  return (
    <div className="card space-y-2">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold">{account.vendor}</h3>
        <span
          className={
            missed
              ? "rounded-full border border-[#c9a227] px-2 py-0.5 text-xs font-semibold text-[#c9a227]"
              : "rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
          }
        >
          {PAYMENT_STATE_LABELS[account.payment_state] ??
            account.payment_state}
        </span>
      </div>
      <p className="text-sm">{account.status}</p>
      {account.reports_to.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Reports to: {account.reports_to.join(", ")}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Reports to: no bureau reporting
        </p>
      )}
      {account.next_due_date ? (
        <p className="text-sm">
          Next payment due: {formatDate(account.next_due_date)}
          {account.amount_due_cents !== null
            ? ` — ${money(account.amount_due_cents)}`
            : ""}
        </p>
      ) : null}
      {account.next_action ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Next step: </span>
          {account.next_action}
        </p>
      ) : null}
      {account.notes ? (
        <p className="text-sm text-muted-foreground">{account.notes}</p>
      ) : null}
    </div>
  );
}

export default function BusinessCreditPage() {
  usePageTitle("Business Credit");
  const [state, setState] = useState<PageState>({ status: "loading" });

  const fetchPage = useCallback(() => {
    apiClient
      .getBusinessCredit()
      .then((data) => setState({ status: "loaded", data }))
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError
            ? err.message
            : "Couldn't reach the server. Try again.";
        setState({ status: "error", message });
      });
  }, []);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  if (state.status === "loading") {
    return (
      <section className="section">
        <p className="text-sm text-muted-foreground">
          Loading your business credit file…
        </p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="section">
        <p className="text-sm">{state.message}</p>
      </section>
    );
  }

  const { data } = state;
  if (!data.available) {
    return (
      <section className="section">
        <div className="card">
          <p className="text-sm">
            Business Credit isn&apos;t switched on yet — the database
            update it needs hasn&apos;t landed. Nothing is wrong; it
            lights up on its own once that lands.
          </p>
        </div>
      </section>
    );
  }

  const { profile, accounts, events } = data;
  return (
    <>
      <section className="section">
        <h2 className="section-title">The company</h2>
        {profile ? (
          <div className="card space-y-1 border-l-4 border-l-[#c9a227]">
            <p className="text-base font-semibold">{profile.legal_name}</p>
            {profile.filed_name && profile.filed_name !== profile.legal_name ? (
              <p className="text-sm text-muted-foreground">
                Filed as {profile.filed_name}
              </p>
            ) : null}
            {profile.duns ? (
              <p className="text-sm">D-U-N-S: {profile.duns}</p>
            ) : null}
            {profile.sunbiz_doc ? (
              <p className="text-sm">
                Sunbiz doc: {profile.sunbiz_doc}
                {profile.sunbiz_status ? ` — ${profile.sunbiz_status}` : ""}
              </p>
            ) : null}
            {profile.registered_address ? (
              <p className="text-sm">{profile.registered_address}</p>
            ) : null}
            {profile.business_email ? (
              <p className="text-sm">{profile.business_email}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No company identity on file yet.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          To change anything here, just tell Abel — &ldquo;Quill is paid
          up&rdquo;, &ldquo;Uline is active now&rdquo; — and he&apos;ll
          confirm it with you and keep this page current. Vendor email
          about invoices and due dates updates the payment lines on its
          own, and Abel buzzes you about it (a missed payment comes
          straight through, any hour).
        </p>
      </section>

      <section className="section">
        <h2 className="section-title">Accounts building the file</h2>
        <div className="space-y-3">
          {accounts.map((account) => (
            <AccountCard key={account.id} account={account} />
          ))}
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No accounts tracked yet.
            </p>
          ) : null}
        </div>
      </section>

      {events.length > 0 ? (
        <section className="section">
          <h2 className="section-title">What Abel logged</h2>
          <ul className="space-y-2">
            {events.map((event) => (
              <li key={event.id} className="card text-sm">
                <span className="text-muted-foreground">
                  {formatDateTime(event.created_at)} —{" "}
                </span>
                {event.summary}
                <span className="text-muted-foreground">
                  {" "}
                  ({SIGNAL_LABELS[event.signal] ?? event.signal})
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
