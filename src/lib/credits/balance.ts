import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/database.types'

export type BalanceRead = {
  /** SUM(delta) over every ledger row the user has, computed by Postgres on each read. */
  balance: number
  /** The user's ledger row count - 0 means they have not been granted their signup credits yet. */
  entries: number
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
  let query = supabase.from('credit_balances').select('balance, entries').eq('user_id', userId)
  // Next memoizes identical GET fetches within one render pass, so a re-read after a write
  // in the same render would replay the first answer; a fresh signal opts out.
  if (fresh) query = query.abortSignal(new AbortController().signal)
  const { data, error } = await query.maybeSingle()
  if (error) {
    throw new Error(`readBalance query failed: ${error.message}`)
  }
  return { balance: data?.balance ?? 0, entries: data?.entries ?? 0 }
}

/**
 * The user's balance. Pure read - the ordinary authenticated client is safe here, unlike
 * ledger.ts's write functions, which need service-role to bypass RLS. Does not grant
 * signup credits - see credits/signup-grant.ts's ensureSignupGrant, which every
 * authenticated page and the real spend gate already call before relying on this
 * figure.
 */
export async function getBalance(userId: string): Promise<number> {
  const supabase = await createClient()
  return (await readBalance(supabase, userId)).balance
}
