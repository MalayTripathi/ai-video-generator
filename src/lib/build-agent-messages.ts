import type { AgentMessage } from '@/components/workbench/agent-message'
import type { Tables } from '@/lib/database.types'
import { describeToolActivity } from '@/lib/agent-activity-display'
import { formatCost } from '@/lib/format-cost'
import { formatCredits } from '@/lib/format-credits'
import { turnCostLineId } from '@/lib/agent-run-end'

// The columns the panel's history is rebuilt from - every `messages` column but project_id,
// which every reader already filters on. Readers select exactly this.
export const AGENT_MESSAGE_COLUMNS = 'id, role, kind, content, client_id, shot_key, tool_name, created_at'
type MessageRow = Pick<
  Tables<'messages'>,
  'id' | 'role' | 'kind' | 'content' | 'client_id' | 'shot_key' | 'tool_name' | 'created_at'
>

/**
 * Reconstructs the agent panel's reload view from persisted `messages` rows, turn by
 * turn - a "turn" being one user row plus everything that followed it (activity rows,
 * then a closing text reply). Tool activity re-derives its display text live from
 * `tool_name`/`shot_key` (never a value stored at write time, which would go stale after
 * a later renumbering) and cost is summed per turn from `usage`, never stored or read
 * from prose. See docs/decisions.md.
 *
 * A turn's closing reply is identified by `client_id` matching the triggering user row's
 * own `client_id`, looked up directly (via a precomputed index) rather than by scanning
 * strictly-contiguous rows. Two turns can interleave in storage - a second tab's
 * near-instant refusal/duplicate-resend can write its whole exchange while a slower first
 * turn is still mid-flight - and a scan that stops at the first non-assistant row would
 * abandon the first turn's real reply, which lands further down the list, even though it
 * exists. When this turn's own reply is known to exist somewhere in the row set, a `user`
 * row encountered while scanning for it is treated as a nested turn and resolved on the
 * spot (recursively) rather than as a stop signal - the agent_turn mutex guarantees only
 * one turn's real tool activity is ever in flight at a time, so any turn interleaved
 * inside another's still-open window is always one of these near-instant, activity-free
 * resolutions, never a second genuinely-concurrent run. Turns still render in the order
 * their user messages were sent, never in the order their replies happened to resolve.
 *
 * When no reply for this client_id exists anywhere yet (a genuinely abandoned turn - the
 * process died mid-flight) or the user row itself has no `client_id` (rows that predate
 * the client_id column), there's no target position to search for, so this falls back to
 * the original contiguous scan: stop at the first non-assistant row.
 */
export function buildAgentMessages(
  rows: MessageRow[], // already ordered by created_at ascending
  shotNumberByKey: Map<string, number>,
  costByMessageId: Map<string, number>,
  creditsByMessageId: Map<string, number>,
  // A plan note's id -> the user message id of the agent turn whose run wrote it
  // (linkRunNotes). Such a note renders directly after that turn's cost line, whenever it
  // was written; any other note renders in time order.
  runNoteTurns: Map<string, string> = new Map()
): AgentMessage[] {
  const out: AgentMessage[] = []

  const userIds = new Set(rows.filter((r) => r.role === 'user').map((r) => r.id))
  const notesByTurn = new Map<string, MessageRow[]>()
  const placedNotes = new Set<string>()
  for (const r of rows) {
    const turnId = r.kind === 'run_note' ? runNoteTurns.get(r.id) : undefined
    if (!turnId || !userIds.has(turnId)) continue
    notesByTurn.set(turnId, [...(notesByTurn.get(turnId) ?? []), r])
    placedNotes.add(r.id)
  }

  const replyIndexByClientId = new Map<string, number>()
  rows.forEach((r, idx) => {
    if (r.role === 'assistant' && r.kind === 'text' && r.client_id && !replyIndexByClientId.has(r.client_id)) {
      replyIndexByClientId.set(r.client_id, idx)
    }
  })

  function pushActivity(a: MessageRow) {
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

  // Resolves the turn starting at rows[startIdx] (a user row), pushing its own entries -
  // and any nested turn's entries, in position order - to `out`. Returns the index to
  // resume scanning from.
  function consumeTurn(startIdx: number): number {
    const row = rows[startIdx]
    out.push({ id: row.id, kind: 'user', content: row.content, createdAt: row.created_at })
    const turnClientId = row.client_id
    const replyIdx = turnClientId ? replyIndexByClientId.get(turnClientId) : undefined

    const activity: MessageRow[] = []
    let closingReply: MessageRow | null = null
    let j = startIdx + 1

    if (replyIdx !== undefined) {
      while (j < rows.length && j !== replyIdx) {
        const r = rows[j]
        if (placedNotes.has(r.id)) {
          j++
          continue
        }
        if (r.role === 'user') {
          j = consumeTurn(j)
          continue
        }
        activity.push(r)
        j++
      }
      if (j === replyIdx) {
        closingReply = rows[j]
        j++
      }
    } else {
      while (j < rows.length && rows[j].role === 'assistant') {
        const r = rows[j]
        if (placedNotes.has(r.id)) {
          j++
          continue
        }
        // A turn's closing reply is always `kind: 'text'` - it carries no turn-level
        // judgement about what happened (see insertAssistantReply's docblock). A mid-turn
        // refusal (a tool declining, or the model's own `decline` call, both via
        // insertToolActivity) is always `kind: 'refusal'` and never carries client_id, by
        // design - it renders in its own position via the activity loop below, never
        // mistaken for the turn's end.
        const isClosingReply = turnClientId
          ? false // already known: no row anywhere carries this client_id
          : r.kind === 'text' && closingReply === null
        if (isClosingReply) {
          closingReply = r
          j++
          break
        }
        activity.push(r)
        j++
      }
    }

    for (const a of activity) pushActivity(a)

    if (closingReply) {
      out.push({
        id: closingReply.id,
        kind: 'agent',
        content: closingReply.content,
        createdAt: closingReply.created_at,
      })
      const cost = costByMessageId.get(row.id) ?? 0
      if (cost > 0) {
        const credits = creditsByMessageId.get(row.id)
        out.push({
          id: turnCostLineId(row.id),
          kind: 'cost',
          content: '',
          amount: formatCost(cost),
          creditAmount: credits !== undefined ? `${formatCredits(credits)} cr` : undefined,
          createdAt: closingReply.created_at,
        })
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
    for (const note of notesByTurn.get(row.id) ?? []) pushActivity(note)

    return j
  }

  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (placedNotes.has(row.id)) {
      i++
      continue
    }
    if (row.role !== 'user') {
      // Outside any turn: a shot run's own note (the outline's message), written by the
      // chain - before the first turn, or after a turn's reply. A plain bubble in position.
      pushActivity(row)
      i++
      continue
    }
    i = consumeTurn(i)
  }

  return out
}

/**
 * Which agent turn wrote each plan note: a note belongs to the latest shot run created
 * before it, and that run's turn (its message_id) when it is an agent run. A button run's
 * note, or one older than every run, is left out - it renders in time order.
 */
export function linkRunNotes(
  rows: readonly Pick<MessageRow, 'id' | 'kind' | 'created_at'>[],
  runs: readonly { message_id: string | null; agent_generation_id: string | null; created_at: string }[]
): Map<string, string> {
  const ordered = [...runs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  const links = new Map<string, string>()
  for (const r of rows) {
    if (r.kind !== 'run_note') continue
    const at = Date.parse(r.created_at)
    const run = ordered.filter((x) => Date.parse(x.created_at) <= at).at(-1)
    if (run?.agent_generation_id && run.message_id) links.set(r.id, run.message_id)
  }
  return links
}
