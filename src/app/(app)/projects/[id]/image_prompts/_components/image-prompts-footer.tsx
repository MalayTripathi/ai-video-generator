'use client'

import { stepLabel } from '@/lib/config/pipeline'
import { useImagePrompts } from './image-prompts-context'
import { describeShotNumbers, isUngenerated } from './derive-image-prompts-phase'

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// Continue stays inert: there is no Storyboard route or advance endpoint to send it to
// yet, so it is deliberately not offered as an enabled control.
export function ImagePromptsFooter() {
  const { shots, busyIds, externalGenerating, outcome } = useImagePrompts()

  const numberById = new Map(shots.map((s) => [s.id, s.order_index + 1]))
  const ungenerated = shots.filter(isUngenerated)

  let note: string
  if (externalGenerating) {
    note = 'Prompts are being written. This page updates when they land.'
  } else if (busyIds.size > 0) {
    note = 'Prompts are being written. The rest of the list stays editable.'
  } else if (outcome?.kind === 'partial') {
    const ids = [...outcome.keptIds, ...outcome.unwrittenIds]
    const nums = ids.map((id) => numberById.get(id) ?? 0).filter((n) => n > 0)
    note =
      outcome.unwrittenIds.length > 0
        ? `${describeShotNumbers(nums)} still ${nums.length === 1 ? 'needs' : 'need'} a prompt. Retry ${nums.length === 1 ? 'it' : 'those'} first.`
        : `${describeShotNumbers(nums)} still ${nums.length === 1 ? 'has its' : 'have their'} previous ${nums.length === 1 ? 'prompt' : 'prompts'}. You can retry ${nums.length === 1 ? 'it' : 'those'} first.`
  } else if (ungenerated.length > 0) {
    note = 'Some shots have no prompt yet.'
  } else {
    note = 'Every shot has a prompt. Edits save when you click away.'
  }

  return (
    <>
      <span className="text-small leading-[1.5] text-text-secondary">{note}</span>
      <button
        type="button"
        disabled
        className="flex h-9 flex-none cursor-pointer items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        Continue to {stepLabel('storyboard')}
        <ArrowIcon />
      </button>
    </>
  )
}
