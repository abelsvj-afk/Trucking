// The one way money becomes text in the app (owner decision 2026-11-12):
// "$1,034.00" - thousands separators, always two decimals, and a loss reads
// "-$568.94", never "$-568.94". Presentation only: it takes integer cents
// exactly as the caller computed them and does no arithmetic of its own
// beyond cents -> dollars. Values for <input> fields are not display text
// and do not go through here.

const TWO_DECIMALS = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Integer cents -> "$1,034.00" / "-$568.94". A value that is not a finite number renders as an em dash, never "$NaN". */
export function formatMoney(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  const amount = TWO_DECIMALS.format(Math.abs(cents) / 100);
  // -0.4 cents rounds to "0.00": no minus sign on a zero.
  return cents < 0 && amount !== "0.00" ? `-$${amount}` : `$${amount}`;
}
