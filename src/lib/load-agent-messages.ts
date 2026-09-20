import type { createClient } from '@/lib/supabase/server'
import type { AgentMessage } from '@/components/workbench/agent-message'
import { buildAgentMessages } from '@/lib/build-agent-messages'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * The agent panel's persisted history for a project, ready to seed `AgentPanel`: the
 * project's `messages` rows plus each turn's cost (from `usage`) and credits (from
 * `credit_ledger`), turned into display messages by `buildAgentMessages`. The chat is one
 * per project, not per step, so every step page loads the same history.
 */
export async function loadAgentMessages(
  supabase: SupabaseServerClient,
  projectId: string,
  shots: { shot_key: string; order_index: number }[]
): Promise<AgentMessage[]> {
  const [{ data: messageRows }, { data: usageRows }, { data: creditLedgerRows }] = await Promise.all([
    supabase
      .from('messages')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    supabase.from('usage').select('message_id, estimated_cost').eq('project_id', projectId).neq('status', 'pending'),
    supabase
      .from('credit_ledger')
      .select('message_id, delta')
      .eq('project_id', projectId)
      .eq('kind', 'spend')
      .eq('operation', 'agent_turn'),
  ])

  const shotNumberByKey = new Map(shots.map((s) => [s.shot_key, s.order_index + 1]))
  const costByMessageId = new Map<string, number>()
  for (const u of usageRows ?? []) {
    if (!u.message_id) continue
    costByMessageId.set(u.message_id, (costByMessageId.get(u.message_id) ?? 0) + (u.estimated_cost ?? 0))
  }
  const creditsByMessageId = new Map<string, number>()
  for (const r of creditLedgerRows ?? []) {
    if (!r.message_id) continue
    creditsByMessageId.set(r.message_id, (creditsByMessageId.get(r.message_id) ?? 0) + -r.delta)
  }
  return buildAgentMessages(messageRows ?? [], shotNumberByKey, costByMessageId, creditsByMessageId)
}
