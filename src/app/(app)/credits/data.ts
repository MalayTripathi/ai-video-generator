import { cache } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/database.types'
import type { Step, Operation } from '@/lib/config/pipeline'
import { getPeriodRange, type Period } from '../usage/period'

/** One `credit_ledger` row, as the aggregation reads it. */
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

/** A group of ledger rows sharing (kind, step, operation, project) within one period:
 * `delta` is their summed delta and `entries` how many rows were summed. */
export type LedgerGroup = {
  kind: string
  step: Step | null
  operation: Operation | null
  project_id: string | null
  delta: number
  entries: number
}

/**
 * A user's `credit_ledger` totals for a period, grouped by Postgres through the
 * `credit_ledger_monthly` view (security_invoker - the caller's own RLS, `user_id =
 * auth.uid()`, scopes it) rather than shipped row by row. `this_month`/`last_month` pick
 * one UTC month; `all_time` folds every month's groups together. Deliberately never
 * joins or queries `usage`: the ledger's independence from `usage` is the property this
 * module exists to preserve. Takes its client so a test can read through a user's own
 * JWT client. A failed read yields no groups, as the row-by-row read it replaced did.
 * `fresh` re-reads past the render's fetch memoization (a re-read after a write).
 */
export async function readLedgerGroups(
  supabase: SupabaseClient<Database>,
  userId: string,
  period: Period,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<LedgerGroup[]> {
  const { start } = getPeriodRange(period)

  let query = supabase
    .from('credit_ledger_monthly')
    .select('kind, step, operation, project_id, credits, entries')
    .eq('user_id', userId)
  if (start) query = query.eq('month', start)
  // Next memoizes identical GET fetches within one render pass; a fresh signal opts out.
  if (fresh) query = query.abortSignal(new AbortController().signal)

  const { data, error } = await query
  if (error) {
    console.error('[credits] ledger groups unreadable:', error.message)
    return []
  }

  const groups = new Map<string, LedgerGroup>()
  for (const row of data) {
    const key = `${row.kind}:${row.step}:${row.operation}:${row.project_id}`
    const existing = groups.get(key)
    if (existing) {
      existing.delta += row.credits ?? 0
      existing.entries += row.entries ?? 0
    } else {
      groups.set(key, {
        kind: row.kind ?? '',
        step: row.step as Step | null,
        operation: row.operation as Operation | null,
        project_id: row.project_id,
        delta: row.credits ?? 0,
        entries: row.entries ?? 0,
      })
    }
  }
  return [...groups.values()]
}

/** readLedgerGroups with the request's own client, request-memoized so the rail and
 * /credits share one read per (userId, period) within a render. */
export const getLedgerGroups = cache(async function getLedgerGroups(userId: string, period: Period): Promise<LedgerGroup[]> {
  return readLedgerGroups(await createClient(), userId, period)
})
