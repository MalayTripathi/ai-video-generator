import type { AgentMessage } from '@/components/workbench/agent-message'
import { formatCost } from '@/lib/format-cost'
import { formatCredits } from '@/lib/format-credits'

/** A turn's cost line id - the same on page load (build-agent-messages.ts) and live. */
export function turnCostLineId(messageId: string): string {
  return `${messageId}-cost`
}

/**
 * The agent panel's list once a shot run it follows has ended: an agent run's turn line takes
 * its settled figures (refund-netted credits, every call's dollars), and the run's plan note
 * goes directly below that line - or, for a button run or a turn with no line, at the end.
 * A note already in the list is never added twice. Pure, so a repeat changes nothing.
 */
export function applyRunEnd(
  prev: AgentMessage[],
  notes: readonly AgentMessage[],
  turn: { messageId: string; credits: number; usd: number } | null
): AgentMessage[] {
  let next = prev
  const lineIndex = turn ? prev.findIndex((m) => m.id === turnCostLineId(turn.messageId)) : -1
  if (turn && lineIndex >= 0) {
    const line = prev[lineIndex]
    const amount = formatCost(turn.usd)
    const creditAmount = `${formatCredits(turn.credits)} cr`
    if (line.amount !== amount || line.creditAmount !== creditAmount) {
      next = [...prev]
      next[lineIndex] = { ...line, amount, creditAmount }
    }
  }
  const seen = new Set(next.map((m) => m.id))
  const fresh = notes.filter((m) => !seen.has(m.id))
  if (fresh.length === 0) return next
  const at = lineIndex >= 0 ? lineIndex + 1 : next.length
  return [...next.slice(0, at), ...fresh, ...next.slice(at)]
}
