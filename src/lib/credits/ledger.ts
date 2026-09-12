import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { isUniqueViolation } from '@/lib/shot-key'
import type { Step, Operation } from '@/lib/config/pipeline'
import { creditsFor, usdToCredits, SIGNUP_GRANT_CREDITS, CREDIT_PRICE_VERSION } from '@/lib/config/credits'

// Every write in this module goes through the service-role client (bypasses RLS -
// credit_ledger has no authenticated write policy by design, see CLAUDE.md). RLS
// normally scopes a query to its caller; a service-role client doesn't, so every
// query here carries an explicit .eq('user_id', userId) by hand instead - a query
// without one is a bug.
//
// Rows are immutable: this module only ever inserts. No UPDATE or DELETE against
// credit_ledger anywhere below.
//
// Balance is SUM(delta), never a stored running total. No Postgres functions/
// triggers/.rpc() (standing rule), and PostgREST aggregate select syntax isn't used
// either - getBalance selects every delta for the user and sums in TypeScript, the
// same shape assertWithinAllowance already uses for the analogous usage-sum problem.
// This is a full-column read of every ledger row a user has ever had; fine at
// current scale, will want revisiting (a real Postgres aggregate, or a maintained
// running total) once row counts grow.

export class InvalidRefundTargetError extends Error {
  constructor(ledgerId: string) {
    super(
      `credit_ledger row ${ledgerId} cannot be refunded: it does not exist, does not ` +
        `belong to this user, or is not a spend.`
    )
    this.name = 'InvalidRefundTargetError'
  }
}

export class DuplicateRefundError extends Error {
  constructor(ledgerId: string) {
    super(`credit_ledger row ${ledgerId} has already been refunded.`)
    this.name = 'DuplicateRefundError'
  }
}

/**
 * Named so every attempt id in the codebase is greppable to one origin. Call at the
 * start of a paid action, before the claim, and carry the result through to the
 * eventual ledger write. Deliberately not derived from generations.id: that column
 * identifies a lock slot, reused across every attempt for a given project/operation,
 * so it can't identify one attempt.
 */
export function mintAttemptId(): string {
  return crypto.randomUUID()
}

/**
 * Sums delta for the user. A user with zero rows gets the signup grant inserted
 * lazily right here - this is the only grant mechanism there is: no trigger, no
 * signup hook, auth.users inserts happen Supabase-side with no application code in
 * the path.
 */
export async function getBalance(userId: string): Promise<number> {
  const supabase = createServiceRoleClient()

  const { data, error } = await supabase.from('credit_ledger').select('delta').eq('user_id', userId)
  if (error) {
    throw new Error(`getBalance query failed: ${error.message}`)
  }

  if (data.length === 0) {
    const { error: insertError } = await supabase.from('credit_ledger').insert({
      user_id: userId,
      kind: 'signup_grant',
      delta: SIGNUP_GRANT_CREDITS,
      dedupe_key: `signup_grant:${userId}`,
      price_version: CREDIT_PRICE_VERSION,
    })

    if (insertError && !isUniqueViolation(insertError)) {
      throw new Error(`getBalance grant insert failed: ${insertError.message}`)
    }

    // Either this call just inserted the grant, or a concurrent first read beat it to
    // the unique (user_id, dedupe_key) index (23505) - either way the grant now
    // exists. Re-read rather than assuming the value.
    return getBalance(userId)
  }

  return data.reduce((sum, row) => sum + row.delta, 0)
}

/**
 * Fixed-price spend. Prices via creditsFor - an unpriced (step, operation) pair
 * throws MissingCreditPriceError, deliberately left to propagate: a missing price
 * must surface, never silently charge nothing.
 */
export async function recordFixedSpend(params: {
  userId: string
  step: Step
  operation: Operation
  quantity: number
  attemptId: string
  projectId: string | null
  messageId?: string | null
  shotKey?: string | null
}): Promise<void> {
  const credits = creditsFor({ step: params.step, operation: params.operation, quantity: params.quantity })
  const supabase = createServiceRoleClient()

  const { error } = await supabase.from('credit_ledger').insert({
    user_id: params.userId,
    kind: 'spend',
    delta: -credits,
    step: params.step,
    operation: params.operation,
    project_id: params.projectId,
    message_id: params.messageId ?? null,
    shot_key: params.shotKey ?? null,
    attempt_id: params.attemptId,
    dedupe_key: `${params.operation}:${params.attemptId}`,
    price_version: CREDIT_PRICE_VERSION,
    pricing_mode: 'fixed',
  })

  if (error && !isUniqueViolation(error)) {
    throw new Error(`recordFixedSpend insert failed: ${error.message}`)
  }
  // A 23505 on dedupe_key means this attempt's spend was already recorded - settle
  // ran twice, or a retry reached settle after the original landed. Swallow it: this
  // function sits in the same position as settleUsage (called around a paid call's
  // settle path), which never throws by design because by then the money is already
  // spent - failing the caller here would lose the user's work on top of the cost.
}

/**
 * Dynamic spend (agent_turn today). `usd` must already be the SUMMED actual cost
 * across every provider call in the action - rounding via usdToCredits happens once
 * here, on the total, never per call.
 */
export async function recordDynamicSpend(params: {
  userId: string
  usd: number
  step: Step
  operation: Operation
  attemptId: string
  projectId: string | null
  messageId?: string | null
}): Promise<void> {
  const credits = usdToCredits(params.usd)
  if (credits === 0) {
    // Genuinely free action - the table's CHECK forbids delta = 0, and a zero-cost
    // action isn't a spend. Writing nothing is correct, not an omission.
    return
  }

  const supabase = createServiceRoleClient()
  const { error } = await supabase.from('credit_ledger').insert({
    user_id: params.userId,
    kind: 'spend',
    delta: -credits,
    step: params.step,
    operation: params.operation,
    project_id: params.projectId,
    message_id: params.messageId ?? null,
    shot_key: null,
    attempt_id: params.attemptId,
    dedupe_key: `${params.operation}:${params.attemptId}`,
    price_version: CREDIT_PRICE_VERSION,
    pricing_mode: 'dynamic',
  })

  if (error && !isUniqueViolation(error)) {
    throw new Error(`recordDynamicSpend insert failed: ${error.message}`)
  }
  // Same swallow-on-duplicate reasoning as recordFixedSpend above.
}

/**
 * Inserts a positive inverse of a prior spend row. Never modifies the refunded row -
 * rows are immutable throughout this module.
 */
export async function recordRefund(params: { userId: string; ledgerId: string }): Promise<void> {
  const supabase = createServiceRoleClient()

  const { data: target, error: selectError } = await supabase
    .from('credit_ledger')
    .select('*')
    .eq('id', params.ledgerId)
    .eq('user_id', params.userId)
    .maybeSingle()

  if (selectError) {
    throw new Error(`recordRefund lookup failed: ${selectError.message}`)
  }
  if (!target || target.kind !== 'spend') {
    throw new InvalidRefundTargetError(params.ledgerId)
  }

  const { error: insertError } = await supabase.from('credit_ledger').insert({
    user_id: params.userId,
    kind: 'refund',
    delta: -target.delta,
    step: target.step,
    operation: target.operation,
    project_id: target.project_id,
    message_id: target.message_id,
    shot_key: target.shot_key,
    refunds_ledger_id: target.id,
    dedupe_key: `refund:${target.id}`,
    price_version: CREDIT_PRICE_VERSION,
  })

  if (insertError) {
    if (isUniqueViolation(insertError)) {
      // dedupe_key is refund:{ledgerId}, unique per user - a second refund attempt on
      // the same row hits it. Unlike a spend's duplicate (settle-position, must never
      // throw), a refund is an explicit one-off correction, not an automatic retry
      // path - throwing surfaces a caller bug instead of masking it. Confirmed with
      // the user.
      throw new DuplicateRefundError(params.ledgerId)
    }
    throw new Error(`recordRefund insert failed: ${insertError.message}`)
  }
}
