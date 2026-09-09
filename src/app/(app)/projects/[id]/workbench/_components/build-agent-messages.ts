import type { AgentMessage } from '@/components/workbench/agent-message'
import type { Tables } from '@/lib/database.types'
import { describeToolActivity } from '@/lib/agent-activity-display'
import { formatCost } from '@/lib/format-cost'

type MessageRow = Tables<'messages'>

/**
 * Reconstructs the agent panel's reload view from persisted `messages` rows, turn by
 * turn - a "turn" being one user row plus everything that followed it (activity rows,
 * then a closing text reply) up to the next user row. Tool activity re-derives its
 * display text live from `tool_name`/`shot_key` (never a value stored at write time,
 * which would go stale after a later renumbering) and cost is summed per turn from
 * `usage`, never stored or read from prose. See docs/decisions.md.
 *
 * A turn's closing reply is identified by `client_id` matching the triggering user row's
 * own `client_id` - not "the first role:'assistant', kind:'text' row seen" - because
 * regenerate_all_shots's nested runShotGeneration call can itself insert an unrelated
 * role:'assistant', kind:'text' row (with client_id null) earlier in the same turn; a
 * naive first-text-row rule would misidentify that as the turn's end and silently drop
 * the real closing reply. When the user row itself has no client_id (rows that predate
 * the client_id column), there's no such collision to guard against, so this falls back
 * to "first text row wins".
 */
export function buildAgentMessages(
  rows: MessageRow[], // already ordered by created_at ascending
  shotNumberByKey: Map<string, number>,
  costByMessageId: Map<string, number>
): AgentMessage[] {
  const out: AgentMessage[] = []
  let i = 0

  while (i < rows.length) {
    const row = rows[i]
    if (row.role !== 'user') {
      i++
      continue
    }
    out.push({ id: row.id, kind: 'user', content: row.content, createdAt: row.created_at })
    const turnClientId = row.client_id
    i++

    const activity: MessageRow[] = []
    let closingReply: MessageRow | null = null
    while (i < rows.length && rows[i].role === 'assistant') {
      const r = rows[i]
      // A turn's closing reply is always `kind: 'text'` - it carries no turn-level
      // judgement about what happened (see insertAssistantReply's docblock). A mid-turn
      // refusal (a tool declining, or the model's own `decline` call, both via
      // insertToolActivity) is always `kind: 'refusal'` and never carries client_id, by
      // design - it renders in its own position via the activity loop below, never
      // mistaken for the turn's end.
      const isClosingReply = turnClientId
        ? r.kind === 'text' && r.client_id === turnClientId
        : r.kind === 'text' && closingReply === null
      if (isClosingReply) {
        closingReply = r
        i++
        break
      }
      activity.push(r)
      i++
    }

    for (const a of activity) {
      if (a.kind === 'tool_done' && a.tool_name) {
        const num = a.shot_key ? (shotNumberByKey.get(a.shot_key) ?? null) : null
        out.push({ id: a.id, kind: 'tool_done', content: describeToolActivity(a.tool_name, num, a.content), createdAt: a.created_at })
      } else if (a.kind === 'refusal') {
        out.push({ id: a.id, kind: 'refusal', content: a.content, createdAt: a.created_at })
      } else {
        // Interstitial prose (e.g. runShotGeneration's own nested message) - a plain
        // bubble in its natural position, not a turn boundary.
        out.push({ id: a.id, kind: 'agent', content: a.content, createdAt: a.created_at })
      }
    }

    if (closingReply) {
      out.push({
        id: closingReply.id,
        kind: 'agent',
        content: closingReply.content,
        createdAt: closingReply.created_at,
      })
      const cost = costByMessageId.get(row.id) ?? 0
      if (cost > 0) {
        out.push({ id: `${row.id}-cost`, kind: 'cost', content: '', amount: formatCost(cost), createdAt: closingReply.created_at })
      }
    } else {
      // Abandoned: no closing reply ever landed (the process died mid-flight). Cost is
      // omitted unconditionally here regardless of what costByMessageId holds - a pending
      // reservation was never confirmed spent.
      out.push({
        id: `${row.id}-abandoned`,
        kind: 'error',
        content: 'This turn never finished, so nothing was changed.',
        createdAt: row.created_at,
        retryContent: row.content,
        retryClientId: row.client_id ?? undefined,
      })
    }
  }

  return out
}
