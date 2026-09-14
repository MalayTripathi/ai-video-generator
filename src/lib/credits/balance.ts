import { createClient } from '@/lib/supabase/server'

/**
 * Sums delta for the user. Pure read - the RLS SELECT policy on credit_ledger
 * (user_id = auth.uid()) makes the ordinary authenticated client safe here, unlike
 * ledger.ts's write functions, which need service-role to bypass RLS. Does not grant
 * signup credits - see credits/signup-grant.ts's ensureSignupGrant, which every
 * authenticated page and the real spend gate already call before relying on this
 * figure.
 */
export async function getBalance(userId: string): Promise<number> {
  const supabase = await createClient()

  const { data, error } = await supabase.from('credit_ledger').select('delta').eq('user_id', userId)
  if (error) {
    throw new Error(`getBalance query failed: ${error.message}`)
  }

  return data.reduce((sum, row) => sum + row.delta, 0)
}
