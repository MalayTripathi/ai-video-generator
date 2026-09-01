import type { createClient } from '@/lib/supabase/server'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// Read live on every call, never cached at import time - a frozen module-level const
// can't be flipped mid-process, which would make it untestable within one test run.
export function isAllowanceEnabled(): boolean {
  return process.env.SPEND_CAP_ENABLED === '1'
}

export function getMonthlyCeilingUsd(): number {
  return Number(process.env.SPEND_CAP_MONTHLY_USD) || 100
}

export class AllowanceExceededError extends Error {
  constructor(
    public readonly usedUsd: number,
    public readonly ceilingUsd: number
  ) {
    super(
      `Monthly usage allowance exceeded: $${usedUsd.toFixed(2)} used this period, ` +
        `ceiling is $${ceilingUsd.toFixed(2)}.`
    )
    this.name = 'AllowanceExceededError'
  }
}

function startOfCurrentMonthUtc(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/**
 * Called immediately before reserveUsage - the last point where nothing has been spent
 * yet. Wired but disabled by default (see isAllowanceEnabled): a no-op that performs NO
 * query at all when off, not a query whose result is ignored.
 *
 * Pending usage rows count toward the sum on purpose - a reservation is a real
 * commitment against the ceiling the moment it's written, not just a settled charge.
 * That's the entire reason reserveUsage writes the pre-flight quote as estimated_cost
 * instead of leaving it null.
 *
 * No .rpc()/raw SQL (repo constraint): sums estimated_cost client-side over the
 * fetched rows rather than using a Postgres aggregate.
 */
export async function assertWithinAllowance(params: {
  supabase: SupabaseServerClient
  userId: string
  quotedCost: number
}): Promise<void> {
  if (!isAllowanceEnabled()) return

  const { supabase, userId, quotedCost } = params
  const periodStart = startOfCurrentMonthUtc()

  const { data, error } = await supabase
    .from('usage')
    .select('estimated_cost')
    .eq('user_id', userId)
    .gte('created_at', periodStart)

  if (error) {
    throw new Error(`assertWithinAllowance query failed: ${error.message}`)
  }

  const used = (data ?? []).reduce((sum, row) => sum + (row.estimated_cost ?? 0), 0)
  const ceiling = getMonthlyCeilingUsd()

  if (used + quotedCost > ceiling) {
    throw new AllowanceExceededError(used, ceiling)
  }
}
