import type { createClient } from '@/lib/supabase/server'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * The real, settled spend for one agent turn - never sourced from the model's own prose.
 * usage.message_id is the turn's own user message id (every reserveUsage call in a turn
 * shares it), and multiple usage rows may legitimately share one message_id (each
 * iteration's own agent_turn Claude call, plus a nested generate_shots call for
 * regenerate_all_shots) - see docs/decisions.md.
 *
 * neq('status', 'pending') excludes a reservation that was never confirmed spent. For a
 * live turn this is belt-and-suspenders (runAgentTurn's finally block force-settles
 * every usage row for the turn before ever calling this), but it is load-bearing on
 * reload: a genuinely abandoned turn (the process died mid-flight, so even that finally
 * block never ran) leaves its usage rows stuck 'pending' forever, and that figure must
 * never be summed into a shown cost - see the abandoned-turn handling in
 * build-agent-messages.ts, which omits the cost line for that case unconditionally
 * regardless of what this function would return.
 */
export async function sumTurnCost(supabase: SupabaseServerClient, messageId: string): Promise<number> {
  const { data } = await supabase.from('usage').select('estimated_cost').eq('message_id', messageId).neq('status', 'pending')
  return (data ?? []).reduce((sum, row) => sum + (row.estimated_cost ?? 0), 0)
}
