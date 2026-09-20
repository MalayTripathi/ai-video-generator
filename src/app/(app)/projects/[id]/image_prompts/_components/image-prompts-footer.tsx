'use client'

import { useImagePrompts } from './image-prompts-context'
import { describeShotNumbers, isUngenerated } from './derive-image-prompts-phase'
import { StoryboardAction } from './storyboard-action'

export function ImagePromptsFooter({ furthestStep }: { furthestStep: number }) {
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
      {/* Disabled while prompts are being written, so a click can't lock the page mid-write. */}
      <StoryboardAction furthestStep={furthestStep} generating={externalGenerating || busyIds.size > 0} />
    </>
  )
}
