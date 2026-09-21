'use client'

import { formatCredits } from '@/lib/format-credits'
import { useImagePrompts } from './image-prompts-context'

// Regenerate Stale is the common, cheaper action and takes a filled neutral surface at
// medium weight; Regenerate All recedes to a quiet outline. Both keep their cost visible
// at rest - the cost is a commitment and belongs in view before the click - and neither
// takes the accent, which stays with Continue.
export function BatchBar() {
  const {
    shots,
    staleCount,
    busyIds,
    externalGenerating,
    regenerateLocked,
    costFor,
    regenerateAll,
    regenerateStale,
  } = useImagePrompts()

  const running = busyIds.size > 0 || externalGenerating
  const staleEnabled = staleCount > 0 && !regenerateLocked

  const note = [
    `${shots.length} ${shots.length === 1 ? 'shot' : 'shots'}`,
    staleCount > 0 ? `${staleCount} stale` : null,
    busyIds.size > 0 ? `${busyIds.size} regenerating` : null,
    externalGenerating ? 'writing in another window' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const staleTitle = running
    ? 'Prompts are already being written'
    : staleCount === 0
      ? 'Nothing is stale'
      : `Rewrite the ${staleCount} stale ${staleCount === 1 ? 'prompt' : 'prompts'}`

  return (
    <div className="flex flex-none items-center justify-between gap-rc-md">
      <span className="text-meta text-text-tertiary">{note}</span>
      <div className="flex flex-none items-center gap-[10px]">
        <button
          type="button"
          onClick={regenerateAll}
          disabled={regenerateLocked}
          className="flex h-[34px] cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-control border border-border-subtle bg-transparent px-rc-sm text-control text-text-secondary outline-none hover:border-border-strong hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          Regenerate All
          <span className="font-mono text-mono text-text-quiet">{formatCredits(costFor(shots.length))} cr</span>
        </button>
        <button
          type="button"
          title={staleTitle}
          onClick={regenerateStale}
          disabled={!staleEnabled}
          className={`flex h-[34px] items-center gap-[7px] whitespace-nowrap rounded-control border px-rc-md text-control outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            staleEnabled
              ? 'cursor-pointer border-border-strong bg-bg-inset font-medium text-text-primary hover:border-border-strong-hover'
              : 'cursor-not-allowed border-border-muted bg-transparent text-text-quiet'
          }`}
        >
          Regenerate Stale
          <span className={`font-mono text-mono ${staleEnabled ? 'text-text-tertiary' : 'text-text-quiet'}`}>
            {running ? 'running' : staleEnabled ? `${formatCredits(costFor(staleCount))} cr` : '—'}
          </span>
        </button>
      </div>
    </div>
  )
}
