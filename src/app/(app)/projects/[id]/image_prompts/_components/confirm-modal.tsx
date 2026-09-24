'use client'

import { overwritePromptContent, PromptConfirmModal, type PromptConfirmContent } from '@/components/prompt-confirm-modal'
import { useImagePrompts } from './image-prompts-context'
import { isEdited } from './derive-image-prompts-phase'

// Overwrite confirmation (canvas 14F) and the Regenerate All confirmation share one
// chrome. The dialog protects handwriting and prices the action; an unedited single
// regeneration never reaches it.
export function ConfirmModal() {
  const { modal, shots, costFor, confirmModal, cancelModal } = useImagePrompts()

  let content: PromptConfirmContent | null = null
  let credits = 0

  if (modal?.kind === 'overwrite') {
    const shot = shots.find((s) => s.id === modal.shotId)
    if (shot) {
      content = overwritePromptContent(shot.order_index + 1, shot.image_prompt ?? '')
      credits = costFor(1)
    }
  } else if (modal) {
    const editedCount = shots.filter(isEdited).length
    content = {
      title: 'Regenerate all prompts?',
      body:
        editedCount > 0
          ? `This rewrites every shot's prompt, including ones already up to date. ${editedCount === 1 ? '1 prompt you edited' : `${editedCount} prompts you edited`} by hand will be overwritten.`
          : "This rewrites every shot's prompt, including ones already up to date.",
      quote: null,
      confirmLabel: 'Regenerate all',
    }
    credits = costFor(shots.length)
  }

  return <PromptConfirmModal content={content} credits={credits} onConfirm={confirmModal} onCancel={cancelModal} />
}
