import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { isUniqueViolation } from '@/lib/shot-key'
import type { Step, Operation } from '@/lib/config/pipeline'
import { creditsFor, usdToCredits, CREDIT_PRICE_VERSION, InsufficientCreditsError, type ImagePriceKey } from '@/lib/config/credits'

// Write-only: spends and refunds. Every write in this module goes through the
// service-role client (bypasses RLS - credit_ledger has no authenticated write
// policy by design, see CLAUDE.md). RLS normally scopes a query to its caller; a
// service-role client doesn't, so every query here carries an explicit
// .eq('user_id', userId) by hand instead - a query without one is a bug.
//
// Rows are immutable: this module only ever inserts. No UPDATE or DELETE against
// credit_ledger anywhere below.
//
// Balance reads live in credits/balance.ts (ordinary client - a read never needs
// service-role, since credit_ledger has a SELECT policy on user_id = auth.uid()) and
// the signup-grant bootstrap lives in credits/signup-grant.ts (service-role, since
// that IS a write) - neither belongs in this write-only module.

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
 * Fixed-price spend. Prices via creditsFor - an unpriced (step, operation) pair, or an
 * image operation without its `image` key, throws MissingCreditPriceError, deliberately
 * left to propagate: a missing price must surface, never silently charge nothing.
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
  /** The call actually made, for an image operation - see creditsFor. */
  image?: ImagePriceKey
}): Promise<void> {
  const credits = creditsFor({
    step: params.step,
    operation: params.operation,
    quantity: params.quantity,
    image: params.image,
  })
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

// ---- Holds -------------------------------------------------------------------------------
// A held action (a shot-generation run today) places one hold at start - a 'spend' row for
// its whole quote - and settles it once at its end: a 'refund' of the unused part, or one
// extra 'spend' for an excess. Balance stays SUM(delta), so a hold lowers it from the moment
// it is placed and the settle brings it to the actual charge.
//
// Concurrency: a hold's dedupe_key is 'hold:{n}', n counted across ALL the user's holds,
// whatever operation placed them. A placer reads the count, THEN the balance, then inserts
// slot n+1: two placers racing read the same count and the (user_id, dedupe_key) unique
// index lets exactly one insert land; the other re-reads and sees the winner's hold in the
// balance. A hold placed after the count was read takes the same slot, so no balance read
// can miss a hold it raced with. No RPC, no lock table. Every future held operation must
// place its holds through placeHold so it serializes against these.

export const HOLD_KEY_PREFIX = 'hold:'
export const SETTLE_KEY_PREFIX = 'settle:'
const HOLD_SLOT_ATTEMPTS = 4

export type HoldRow = { id: string; credits: number }

type HoldTarget = {
  userId: string
  attemptId: string
  step: Step
  operation: Operation
  pricingMode: 'fixed' | 'dynamic'
  projectId: string | null
  messageId?: string | null
}

async function findHold(supabase: ReturnType<typeof createServiceRoleClient>, userId: string, attemptId: string) {
  return supabase
    .from('credit_ledger')
    .select('id, delta, step, operation, project_id, message_id, pricing_mode')
    .eq('user_id', userId)
    .eq('attempt_id', attemptId)
    .eq('kind', 'spend')
    .like('dedupe_key', `${HOLD_KEY_PREFIX}%`)
    .maybeSingle()
}

/**
 * Places the hold for a held action, atomically with its balance check. Throws
 * InsufficientCreditsError when the balance doesn't cover `credits`, and a plain Error when
 * the hold can't be written - the one ledger write that must fail its request, since nothing
 * has been spent yet. Idempotent per attempt: a hold already placed for it is returned.
 */
export async function placeHold(params: HoldTarget & { credits: number }): Promise<HoldRow> {
  const supabase = createServiceRoleClient()
  const existing = await findHold(supabase, params.userId, params.attemptId)
  if (existing.error) throw new Error(`placeHold lookup failed: ${existing.error.message}`)
  if (existing.data) return { id: existing.data.id, credits: -existing.data.delta }

  for (let attempt = 0; attempt < HOLD_SLOT_ATTEMPTS; attempt++) {
    // Count first, balance second - the order the race argument above depends on.
    const { count, error: countError } = await supabase
      .from('credit_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', params.userId)
      .like('dedupe_key', `${HOLD_KEY_PREFIX}%`)
    if (countError || count === null) throw new Error(`placeHold count failed: ${countError?.message ?? 'no count'}`)
    const { data: balanceRow, error: balanceError } = await supabase
      .from('credit_balances')
      .select('balance')
      .eq('user_id', params.userId)
      .abortSignal(new AbortController().signal)
      .maybeSingle()
    if (balanceError) throw new Error(`placeHold balance read failed: ${balanceError.message}`)
    const balance = balanceRow?.balance ?? 0
    if (balance < params.credits) throw new InsufficientCreditsError(params.credits, balance)

    const { data, error } = await supabase
      .from('credit_ledger')
      .insert({
        user_id: params.userId,
        kind: 'spend',
        delta: -params.credits,
        step: params.step,
        operation: params.operation,
        project_id: params.projectId,
        message_id: params.messageId ?? null,
        shot_key: null,
        attempt_id: params.attemptId,
        dedupe_key: `${HOLD_KEY_PREFIX}${count + 1}`,
        price_version: CREDIT_PRICE_VERSION,
        pricing_mode: params.pricingMode,
        refunds_ledger_id: null,
      })
      .select('id')
      .single()
    if (!error && data) return { id: data.id, credits: params.credits }
    if (error && !isUniqueViolation(error)) throw new Error(`placeHold insert failed: ${error.message}`)
    // Another hold took slot n+1 between this count and insert: re-read and try the next.
  }
  throw new Error('placeHold could not take a hold slot: too many concurrent holds')
}

export type SettleOutcome = 'settled' | 'already_settled' | 'nothing_to_write' | 'failed'

/**
 * Settles an action's hold at its actual charge: a 'refund' of hold - actual (pointing at the
 * hold through refunds_ledger_id), or one extra 'spend' of actual - hold. With `capAtHold`
 * (a shot-list button run) the charge never exceeds the hold: an overrun is the platform's. Both carry
 * dedupe_key 'settle:{hold id}', so a hold is settled exactly once. Never throws - by now the
 * money is spent; a failure logs and returns 'failed', so the caller leaves its run uncharged
 * for the next settle to retry. An action with no hold (one started before holds existed)
 * is charged its actual as a single spend, as it would have been then.
 */
export async function settleHold(params: HoldTarget & { actualCredits: number; capAtHold?: boolean }): Promise<SettleOutcome> {
  try {
    const supabase = createServiceRoleClient()
    const { data: hold, error } = await findHold(supabase, params.userId, params.attemptId)
    if (error) throw new Error(`settleHold lookup failed: ${error.message}`)
    const actual = Math.max(0, Math.round(params.actualCredits))

    if (!hold) {
      if (actual === 0) return 'nothing_to_write'
      const { error: spendError } = await supabase.from('credit_ledger').insert({
        user_id: params.userId,
        kind: 'spend',
        delta: -actual,
        step: params.step,
        operation: params.operation,
        project_id: params.projectId,
        message_id: params.messageId ?? null,
        shot_key: null,
        attempt_id: params.attemptId,
        dedupe_key: `${params.operation}:${params.attemptId}`,
        price_version: CREDIT_PRICE_VERSION,
        pricing_mode: params.pricingMode,
        refunds_ledger_id: null,
      })
      if (spendError && !isUniqueViolation(spendError)) throw new Error(`settleHold spend failed: ${spendError.message}`)
      return spendError ? 'already_settled' : 'settled'
    }

    const held = -hold.delta
    const charge = params.capAtHold ? Math.min(actual, held) : actual
    if (charge === held) return 'nothing_to_write'
    const base = {
      user_id: params.userId,
      step: hold.step,
      operation: hold.operation,
      project_id: hold.project_id,
      message_id: hold.message_id,
      shot_key: null,
      attempt_id: params.attemptId,
      dedupe_key: `${SETTLE_KEY_PREFIX}${hold.id}`,
      price_version: CREDIT_PRICE_VERSION,
    }
    // A refund of the unused hold, or one extra spend for the excess - one row either way.
    const refund = charge < held
    const { error: insertError } = await supabase.from('credit_ledger').insert({
      ...base,
      kind: refund ? 'refund' : 'spend',
      delta: held - charge,
      pricing_mode: refund ? null : hold.pricing_mode,
      refunds_ledger_id: refund ? hold.id : null,
    })
    if (insertError && !isUniqueViolation(insertError)) throw new Error(`settleHold insert failed: ${insertError.message}`)
    return insertError ? 'already_settled' : 'settled'
  } catch (err) {
    console.error(`[credits] settleHold failed for attempt ${params.attemptId}`, err)
    return 'failed'
  }
}
