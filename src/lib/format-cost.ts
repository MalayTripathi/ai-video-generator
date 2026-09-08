// The one place a dollar figure is formatted. Costs here are small (fractions of a
// cent per call), so 2 decimals is never enough: most real calls differ only in their
// third decimal (e.g. $0.008 vs $0.012), and both would render as the same "$0.01" -
// indistinguishable, not just imprecise. A minimum of 3 decimals is always shown; this
// widens further only for a cost too small even for that (< $0.0005), so it still never
// disappears into rounding as a flat "$0.000".
const MIN_DECIMALS = 3
const MAX_DECIMALS = 6

export function formatCost(cost: number | null): string {
  if (cost === null) return 'unmeasured'
  if (cost === 0) return `$${(0).toFixed(MIN_DECIMALS)}`

  for (let decimals = MIN_DECIMALS; decimals <= MAX_DECIMALS; decimals++) {
    const fixed = cost.toFixed(decimals)
    if (Number(fixed) !== 0) return `$${fixed}`
  }
  return `$${cost.toFixed(MAX_DECIMALS)}`
}
