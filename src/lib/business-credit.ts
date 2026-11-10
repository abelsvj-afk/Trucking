import type {
  BusinessCreditAccount,
  BusinessCreditEvent,
  BusinessCreditProfile,
} from "@/types/entities";

/**
 * Business Credit page data (migration 00087;
 * docs/design/business-credit.md). `available: false` = 00087 hasn't
 * landed yet; the page says so honestly instead of erroring.
 */
export interface BusinessCreditData {
  available: boolean;
  profile: BusinessCreditProfile | null;
  accounts: BusinessCreditAccount[];
  events: BusinessCreditEvent[];
}

export const PAYMENT_STATE_LABELS: Record<string, string> = {
  none: "Nothing due",
  invoice_open: "Invoice open",
  due_soon: "Payment due",
  paid: "Paid",
  missed: "MISSED — past due",
};
