// The one place a credit figure is formatted. Credits are always whole numbers (the
// ledger's `delta` column is an integer), so unlike formatCost there is no decimals
// question - just thousands grouping for a readable balance (e.g. "5,000").
export function formatCredits(credits: number): string {
  return new Intl.NumberFormat('en-US').format(credits)
}
