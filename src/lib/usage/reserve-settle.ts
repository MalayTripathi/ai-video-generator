import type { createClient } from '@/lib/supabase/server'
import type { Step, Operation, Provider } from '@/lib/config/pipeline'
import { computeCost, type UsageBreakdown } from '@/lib/config/pricing'
import { RATE_VERSION } from '@/lib/config/pricing'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Reserve-then-settle replaces the old logClaudeUsage, which only wrote a `usage` row
 * AFTER a successful Claude response - so a call that threw, timed out, or was killed
 * mid-stream was billed but left no row at all. reserveUsage/settleUsage are called
 * around the gateway call instead of after it:
 *
 *   assertWithinAllowance -> reserveUsage -> gateway.createMessage -> settleUsage (finally)
 *
 * The two halves are deliberately asymmetric, and this is not a bug to "clean up":
 *
 * - reserveUsage THROWS if its INSERT fails. Nothing has been spent yet at that point,
 *   so refusing to proceed to the gateway call is free - calling Claude without a
 *   reservation row would be unguarded spend, exactly the defect being fixed.
 *
 * - settleUsage NEVER THROWS. By the time it runs, the money may already be spent -
 *   failing the request at that point would lose the user's work on top of the spend.
 *   If its own UPDATE fails, it logs loudly (console.error with the usage id) and
 *   leaves the row 'pending'. A row stuck 'pending' is the deliberate signal for a call
 *   that died mid-flight: it over-counts against a future spend cap rather than
 *   under-counting, which is the safe direction to be wrong in.
 */

export async function reserveUsage(params: {
  supabase: SupabaseServerClient
  userId: string
  projectId: string
  generationId: string
  shotId: string | null
  step: Step
  operation: Operation
  provider: Provider
  model: string
  quotedCost: number
  quotedBreakdown: UsageBreakdown
}): Promise<{ usageId: string }> {
  const now = new Date().toISOString()

  const { data, error } = await params.supabase
    .from('usage')
    .insert({
      user_id: params.userId,
      project_id: params.projectId,
      generation_id: params.generationId,
      shot_id: params.shotId,
      // No chat/agent-turn concept exists yet to attach a message to. Left in the
      // signature so a future caller (C4) doesn't need every reserveUsage call site
      // touched again just to start passing one.
      message_id: null,
      step: params.step,
      operation: params.operation,
      provider: params.provider,
      model: params.model,
      status: 'pending',
      estimated_cost: params.quotedCost,
      rate_version: RATE_VERSION,
      // Stored so a stuck-pending row is debuggable: shows what was guessed, not just
      // a bare number. settleUsage fully overwrites this with the measured breakdown.
      raw_usage: { quoted: params.quotedBreakdown },
      updated_at: now,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`reserveUsage insert failed: ${error?.message ?? 'no row returned'}`)
  }

  return { usageId: data.id }
}

export async function settleUsage(params: {
  supabase: SupabaseServerClient
  usageId: string
  provider: Provider
  model: string
  status: 'succeeded' | 'failed'
  /** null/absent when nothing was ever measured - a throw before the gateway returned anything. */
  breakdown?: UsageBreakdown | null
  stopReason?: string | null
  error?: string | null
}): Promise<void> {
  const update: Record<string, unknown> = {
    status: params.status,
    stop_reason: params.stopReason ?? null,
    updated_at: new Date().toISOString(),
  }

  if (params.breakdown) {
    const { estimatedCost, appliedRates, quantity, unit } = computeCost(
      params.provider,
      params.model,
      params.breakdown
    )
    update.estimated_cost = estimatedCost
    update.quantity = quantity
    update.unit = unit
    update.raw_usage = { breakdown: params.breakdown, rates: appliedRates }
  } else {
    // No usage data available - a hard throw before the gateway ever returned
    // anything. estimated_cost is intentionally left out of `update` below so the
    // pre-flight quote written at reserve time survives untouched (see module
    // docblock: over-counting is the safe direction for a future spend cap).
    update.raw_usage = { unmeasured: true, error: params.error ?? null }
  }

  const { error } = await params.supabase.from('usage').update(update).eq('id', params.usageId)

  if (error) {
    // Do not throw - the money is already spent, and failing the request now would
    // lose the user's work on top of it. The row stays 'pending', which is the
    // deliberate signal for a call that died mid-flight.
    console.error(`[usage] SETTLE update failed for usage id=${params.usageId}`, error.message)
  }
}
