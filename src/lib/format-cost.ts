// The one place a dollar figure is formatted. Costs here are small (fractions of a
// cent per call), so a fixed 2-decimal format would truthfully render a real nonzero
// cost as "$0.00" - this widens the precision only as far as needed to show a nonzero
// digit, so a real cost never disappears into rounding.
export function formatCost(cost: number | null): string {
  if (cost === null) return 'unmeasured'
  if (cost === 0) return '$0.00'

  for (let decimals = 2; decimals <= 6; decimals++) {
    const fixed = cost.toFixed(decimals)
    if (Number(fixed) !== 0) return `$${fixed}`
  }
  return `$${cost.toFixed(6)}`
}
