import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/database.types'

export type BalanceRead = {
  /** SUM(delta) over every ledger row the user has, computed by Postgres on each read. */
  balance: number
  /** The user's ledger row count - 0 means they have not been granted their signup credits yet. */
  entries: number
  /** The earliest "last alive" time across the user's open holds, or null when none is open.
   * readSettledBalance (release-stale-holds.ts) compares it with the stale window. */
  openHoldLiveAt: string | null
}

/**
 * Reads the user's balance from the `credit_balances` view (security_invoker, so the
 * caller's own credit_ledger RLS applies - `user_id = auth.uid()`). Postgres does the
 * SUM; no ledger rows are shipped to JS. A user with no ledger rows has no view row,
 * which reads as zero balance and zero entries. Takes its client so a test can read
 * through a user's own JWT client. `fresh` re-reads past the render's fetch memoization.
 */
export async function readBalance(
  supabase: SupabaseClient<Database>,
  userId: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<BalanceRead> {
  let query = supabase.from('credit_balances').select('balance, entries, open_hold_live_at').eq('user_id', userId)
  // Next memoizes identical GET fetches within one render pass, so a re-read after a write
  // in the same render would replay the first answer; a fresh signal opts out.
  if (fresh) query = query.abortSignal(new AbortController().signal)
  const { data, error } = await query.maybeSingle()
  if (error) {
    throw new Error(`readBalance query failed: ${error.message}`)
  }
  return { balance: data?.balance ?? 0, entries: data?.entries ?? 0, openHoldLiveAt: data?.open_hold_live_at ?? null }
}

/**
 * Folds an attempt's ledger rows into its hold and net charge (hold less refund, plus excess):
 * what a held run placed at start and what it was finally charged. Null when it placed none.
 */
export function holdAndSettle(rows: readonly { kind: string; delta: number; dedupe_key: string }[]): {
  held: number | null
  charged: number | null
} {
  const hold = rows.find((r) => r.kind === 'spend' && r.dedupe_key.startsWith('hold:'))
  if (!hold) return { held: null, charged: null }
  const settle = rows.find((r) => r.dedupe_key.startsWith('settle:'))
  return { held: -hold.delta, charged: -hold.delta - (settle?.delta ?? 0) }
}

/**
 * The user's balance, for every credit check - with any dead run's hold released first
 * (readSettledBalance; one query when none is). Does not grant signup credits - see
 * credits/signup-grant.ts's ensureSignupGrant, which every authenticated page and the real
 * spend gate already call before relying on this figure.
 */
export async function getBalance(userId: string): Promise<number> {
  const supabase = await createClient()
  const { readSettledBalance } = await import('./release-stale-holds')
  return (await readSettledBalance(supabase, userId)).balance
}
