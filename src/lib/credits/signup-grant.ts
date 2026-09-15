import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { isUniqueViolation } from '@/lib/shot-key'
import { SIGNUP_GRANT_CREDITS, CREDIT_PRICE_VERSION } from '@/lib/config/credits'

/**
 * Ensures a user has their signup-grant row. Idempotent and never throws - called on
 * every authenticated page load (src/app/(app)/layout.tsx) and again, defensively,
 * immediately before the real spend gate (runElementReferenceGeneration), so a
 * transient failure here must never break a page render or bubble past a caller
 * expecting a balance, not an exception. A repeat call costs one existence check, not
 * a write. Concurrent first calls are resolved by the (user_id, dedupe_key) unique
 * index and detected by Postgres error code (23505), never by message text - same as
 * every other ledger write.
 */
export async function ensureSignupGrant(userId: string): Promise<void> {
  const supabase = createServiceRoleClient()

  const { data: existing, error: selectError } = await supabase
    .from('credit_ledger')
    .select('id')
    .eq('user_id', userId)
    .eq('dedupe_key', `signup_grant:${userId}`)
    .maybeSingle()

  if (selectError) {
    console.error(`[credits] ensureSignupGrant existence check failed for user ${userId}:`, selectError.message)
    return
  }
  if (existing) return

  const { error: insertError } = await supabase.from('credit_ledger').insert({
    user_id: userId,
    kind: 'signup_grant',
    delta: SIGNUP_GRANT_CREDITS,
    dedupe_key: `signup_grant:${userId}`,
    price_version: CREDIT_PRICE_VERSION,
  })

  if (insertError && !isUniqueViolation(insertError)) {
    console.error(`[credits] ensureSignupGrant insert failed for user ${userId}:`, insertError.message)
  }
}
