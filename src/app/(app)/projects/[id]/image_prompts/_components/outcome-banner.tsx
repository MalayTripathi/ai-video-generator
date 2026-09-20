'use client'

import { formatCredits } from '@/lib/format-credits'
import { useImagePrompts } from './image-prompts-context'
import { describeShotNumbers } from './derive-image-prompts-phase'

function creditsLabel(n: number) {
  return `${formatCredits(n)} ${n === 1 ? 'credit' : 'credits'}`
}

// Failure-banner case 1 (canvas 14E): a 2px failed rule, the count, what survived, a
// timestamped code, one action. Per-card outcomes carry the rest.
export function OutcomeBanner() {
  const { outcome, shots, regenerateLocked, costFor, retryOutcome } = useImagePrompts()
  if (!outcome || outcome.kind === 'insufficient') return null

  const numberById = new Map(shots.map((s) => [s.id, s.order_index + 1]))
  const numbersOf = (ids: string[]) => ids.map((id) => numberById.get(id) ?? 0).filter((n) => n > 0)

  let title: string
  let body: string
  let retryCount: number

  if (outcome.kind === 'partial') {
    const kept = outcome.keptIds
    const unwritten = outcome.unwrittenIds
    const failed = kept.length + unwritten.length
    retryCount = failed
    title =
      kept.length === 0
        ? `${failed} of ${outcome.scopeSize} prompts weren't written`
        : `${failed} of ${outcome.scopeSize} prompts didn't regenerate`
    const parts: string[] = []
    if (kept.length > 0) {
      parts.push(`${describeShotNumbers(numbersOf(kept))} kept ${kept.length === 1 ? 'its' : 'their'} previous ${kept.length === 1 ? 'prompt' : 'prompts'}.`)
    }
    if (unwritten.length > 0) {
      parts.push(`${describeShotNumbers(numbersOf(unwritten))} ${unwritten.length === 1 ? 'has' : 'have'} no prompt yet.`)
    }
    if (outcome.updatedIds.length > 0) {
      parts.push(`The other ${outcome.updatedIds.length} ${outcome.updatedIds.length === 1 ? 'is' : 'are'} updated.`)
    }
    body = parts.join(' ')
  } else {
    retryCount = outcome.retryIds.length
    title = "Couldn't write the prompts"
    body =
      outcome.code === 'timeout'
        ? 'This is taking longer than expected.'
        : "Nothing new was saved, and you weren't charged for it."
  }

  return (
    <div
      role="alert"
      className="relative flex flex-none items-center gap-rc-sm overflow-hidden rounded-control bg-status-failed-bg p-[13px_15px]"
    >
      <span className="absolute inset-y-0 left-0 w-[2px] bg-status-failed-fg" aria-hidden />
      <div className="flex flex-1 flex-col gap-1 pl-rc-2xs">
        <span className="text-ui font-medium text-banner-failed-title">{title}</span>
        <span className="text-small text-banner-failed-body">
          {body} <span className="font-mono text-label">{outcome.code} · {outcome.at}</span>
        </span>
      </div>
      {retryCount > 0 && (
        <button
          type="button"
          onClick={retryOutcome}
          disabled={regenerateLocked}
          className="flex h-8 flex-none cursor-pointer items-center whitespace-nowrap rounded-control border border-accent bg-transparent px-rc-sm text-small font-medium text-accent outline-none hover:bg-status-failed-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {outcome.kind === 'partial' ? (retryCount === 1 ? 'Retry that one' : `Retry those ${retryCount}`) : 'Try again'} ·{' '}
          {creditsLabel(costFor(retryCount))}
        </button>
      )}
    </div>
  )
}
