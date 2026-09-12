import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import type { Step, Operation } from '@/lib/config/pipeline'
import { getPeriodRange, type Period } from '../usage/period'

export type LedgerRow = {
  id: string
  kind: string
  step: Step | null
  operation: Operation | null
  project_id: string | null
  message_id: string | null
  delta: number
  created_at: string
}

/**
 * Fetches a user's `credit_ledger` rows for a period - the ledger's one and only
 * reader today. Deliberately never joins or queries `usage`: the ledger's
 * independence from `usage` is the property this whole module exists to preserve. RLS
 * (`user_id = auth.uid()`, SELECT-only) already scopes this to the caller's own rows,
 * so a plain authenticated client is correct here - no service-role, no write.
 * Request-memoized the same way usage/data.ts's getUsageRows is, so the credits page
 * calling this twice (all-time for the balance tile, period-scoped for everything
 * else) collapses to one query when the active tab is already "All time".
 */
export const getLedgerRows = cache(async function getLedgerRows(userId: string, period: Period): Promise<LedgerRow[]> {
  const supabase = await createClient()
  const { start, end } = getPeriodRange(period)

  let query = supabase
    .from('credit_ledger')
    .select('id, kind, step, operation, project_id, message_id, delta, created_at')
    .eq('user_id', userId)

  if (start) query = query.gte('created_at', start)
  if (end) query = query.lt('created_at', end)

  const { data } = await query

  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    step: row.step as Step | null,
    operation: row.operation as Operation | null,
    project_id: row.project_id,
    message_id: row.message_id,
    delta: row.delta,
    created_at: row.created_at,
  }))
})
