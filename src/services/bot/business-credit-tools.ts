import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { insertRow, patchLiveRow, validateWith } from "./tool-helpers";
import { updateBusinessCreditAccountSchema } from "@/data/schemas/business-credit";
import { loadBusinessCredit } from "@/services/business-credit/store";
import type { BusinessCreditAccount } from "@/types/entities";

/**
 * Business Credit tools (migration 00087;
 * docs/design/business-credit.md). The read lists the identity header,
 * every tracked account, and the newest audit events — including what
 * the email watch changed and which email caused it. The write follows
 * the standing propose→yes discipline (the loop stages writes; it only
 * executes after his yes) and audit-logs itself as an `abel_tool`
 * event. On a database where 00087 hasn't landed, both answer with one
 * honest "not switched on yet" sentence.
 */

const NOT_LANDED =
  "Business Credit isn't switched on yet — the database update it needs (00087) hasn't landed. Nothing is broken; it lights up on its own once King applies it.";

function accountLine(a: BusinessCreditAccount): string {
  const bits = [`${a.vendor} — ${a.status}`];
  if (a.reports_to.length > 0)
    bits.push(`reports to ${a.reports_to.join(", ")}`);
  if (a.payment_state !== "none") {
    bits.push(
      `payment: ${a.payment_state}${a.next_due_date ? `, due ${a.next_due_date}` : ""}${a.amount_due_cents !== null ? `, $${(a.amount_due_cents / 100).toFixed(2)}` : ""}`,
    );
  }
  if (a.next_action) bits.push(`next: ${a.next_action}`);
  return `- ${bits.join("; ")}`;
}

export function buildBusinessCreditTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;
  const tools: AgentTool[] = [
    {
      name: "list_business_credit_accounts",
      description:
        "The company's business-credit file: the LLC identity header (legal name, D-U-N-S, Sunbiz doc, address, business email — never any EIN), every tracked vendor account (Dun & Bradstreet, Quill, Uline, eCredable, Nav, Bluevine) with its phase, which bureaus it reports to, the next action, and any payment state/due date — plus the newest audit events, including what the vendor-email watch changed and which email caused it. Use for 'how's my business credit', 'what does Quill report to', 'when do I call Uline', 'did any vendor bill come in'.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      access: "read",
      async run() {
        const data = await loadBusinessCredit(client, companyId, 8);
        if (!data.available) return NOT_LANDED;
        const lines: string[] = [];
        if (data.profile) {
          const p = data.profile;
          lines.push(
            `${p.legal_name}${p.duns ? ` · D-U-N-S ${p.duns}` : ""}${p.sunbiz_doc ? ` · Sunbiz ${p.sunbiz_doc}${p.sunbiz_status ? ` (${p.sunbiz_status})` : ""}` : ""}`,
          );
        }
        lines.push(...data.accounts.map(accountLine));
        if (data.events.length > 0) {
          lines.push("Recent activity:");
          for (const e of data.events) {
            lines.push(
              `- ${e.created_at.slice(0, 10)}: ${e.summary} (${e.source === "email_watch" ? "email watch" : e.source})`,
            );
          }
        }
        return lines.join("\n");
      },
    },
    {
      name: "update_business_credit_account",
      description:
        "Update one business-credit account after he tells you something changed: the phase/status in his words ('Uline is active now'), the next action, the payment state (none, invoice_open, due_soon, paid, missed), the next due date (YYYY-MM-DD), the amount due in cents, the notes, or which bureaus it reports to. Address the account by vendor_key (dun-and-bradstreet, quill, uline, ecredable, nav, bluevine). Like every Abel write this is staged for his confirmation — it never orders anything, never activates a subscription (eCredable stays parked until he says HE subscribed), and never invents a due date: only set next_due_date when he or a vendor email states one.",
      parameters: {
        type: "object",
        properties: {
          vendor_key: {
            type: "string",
            description:
              "dun-and-bradstreet | quill | uline | ecredable | nav | bluevine",
          },
          status: { type: "string" },
          next_action: { type: ["string", "null"] },
          payment_state: {
            type: "string",
            enum: ["none", "invoice_open", "due_soon", "paid", "missed"],
          },
          next_due_date: { type: ["string", "null"] },
          amount_due_cents: { type: ["number", "null"] },
          notes: { type: ["string", "null"] },
          reports_to: { type: "array", items: { type: "string" } },
        },
        required: ["vendor_key"],
        additionalProperties: false,
      },
      access: "write",
      validateArgs: validateWith(updateBusinessCreditAccountSchema),
      summarize: (a) => {
        const fields = Object.keys(a).filter((k) => k !== "vendor_key");
        return `Update the ${String(a.vendor_key)} business-credit account (${fields.join(", ")})`;
      },
      async run(args) {
        // The loop already ran validateArgs (validateWith over the
        // same schema); parse directly here like the other modules.
        const { vendor_key, ...patch } =
          updateBusinessCreditAccountSchema.parse(args);
        const data = await loadBusinessCredit(client, companyId, 0);
        if (!data.available) return NOT_LANDED;
        const account = data.accounts.find((a) => a.vendor_key === vendor_key);
        if (!account) {
          return `No business-credit account with key "${vendor_key}". The tracked keys are: ${data.accounts.map((a) => a.vendor_key).join(", ")}.`;
        }
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          before[key] = (account as unknown as Record<string, unknown>)[key];
          after[key] = value;
        }
        await patchLiveRow(client, "business_credit_accounts", companyId, account.id, {
          ...after,
          updated_at: new Date().toISOString(),
        });
        await insertRow(client, "business_credit_events", companyId, {
          account_id: account.id,
          source: "abel_tool",
          signal: "update",
          summary: `${account.vendor} updated: ${Object.keys(after).join(", ")}`,
          detail: { before, after },
          buzz_state: "none",
        });
        return `${account.vendor} updated (${Object.keys(after).join(", ")}). The Business Credit page shows it now.`;
      },
    },
  ];
  return tools;
}
