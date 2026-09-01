import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import type { Step, Operation } from '@/lib/config/pipeline'
import { getPeriodRange, type Period } from './period'
import type { UsageRow } from './aggregate'

/**
 * Fetches a user's `usage` rows for a period - the one query both the /usage page and
 * the rail's spend figure read from. Wrapped in React's cache() (Next's documented
 * request-memoization pattern) so calling it twice with the same (userId, period)
 * within one request - the layout for the rail, then the /usage page below it for the
 * full breakdown - reuses the first query's result instead of hitting the database
 * twice. This is per-request memoization only, not a persistent cache.
 */
export const getUsageRows = cache(async function getUsageRows(userId: string, period: Period): Promise<UsageRow[]> {
  const supabase = await createClient()
  const { start, end } = getPeriodRange(period)

  let query = supabase
    .from('usage')
    .select('id, project_id, step, operation, status, estimated_cost, quoted_cost, created_at, raw_usage')
    .eq('user_id', userId)

  if (start) query = query.gte('created_at', start)
  if (end) query = query.lt('created_at', end)

  const { data } = await query

  return (data ?? []).map((row) => ({
    id: row.id,
    project_id: row.project_id,
    step: row.step as Step,
    operation: row.operation as Operation,
    status: row.status,
    estimated_cost: row.estimated_cost,
    quoted_cost: row.quoted_cost,
    created_at: row.created_at,
    blocked: (row.raw_usage as { blocked?: boolean } | null)?.blocked === true,
  }))
})
