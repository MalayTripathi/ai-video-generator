'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { creditsFor } from '@/lib/config/credits'
import { useShots } from './shots-context'
import { ShotsFooter } from './shots-footer'
import { ImagePromptsConfirmModal } from './image-prompts-confirm-modal'

type ModalPhase = 'closed' | 'confirm' | 'submitting' | 'insufficient'

// Shared across all three Workbench tabs (Shots, Assets, Script) - one implementation.
// Only elements attached to at least one shot count: an unbound element's missing
// reference can't affect any output, so counting it would be a warning nobody can act on.
export function WorkbenchFooter() {
  const router = useRouter()
  const { projectId, shots } = useShots()

  const [modalPhase, setModalPhase] = useState<ModalPhase>('closed')
  const [insufficient, setInsufficient] = useState<{ required: number; balance: number } | null>(null)

  // Display-only, reactive to live shot count; the route recomputes its own
  // authoritative quantity from a fresh DB read - creditsFor's own quantity must
  // always be server-derived, never trusted from the client.
  const requiredCredits = creditsFor({
    step: 'image_prompts',
    operation: 'write_image_prompts',
    quantity: shots.length,
  })

  const namesWithoutReference = new Map<string, string>()
  for (const shot of shots) {
    for (const el of shot.elements) {
      if (!el.reference_image_path && !namesWithoutReference.has(el.id)) {
        namesWithoutReference.set(el.id, el.name)
      }
    }
  }

  function openModal() {
    setInsufficient(null)
    setModalPhase('confirm')
  }

  function cancel() {
    setModalPhase('closed')
    setInsufficient(null)
  }

  async function confirm() {
    setModalPhase('submitting')
    try {
      const res = await fetch(`/api/projects/${projectId}/image_prompts/advance`, { method: 'POST' })
      const body = await res.json()

      if (res.ok && body.ok) {
        router.push(`/projects/${projectId}/image_prompts`)
        return
      }

      if (res.status === 402) {
        setInsufficient({ required: body.requiredCredits, balance: body.balanceCredits })
        setModalPhase('insufficient')
        return
      }

      console.error('[workbench] advance to image_prompts failed', body)
      setModalPhase('confirm')
    } catch (err) {
      console.error('[workbench] advance to image_prompts request failed', err)
      setModalPhase('confirm')
    }
  }

  return (
    <>
      <ShotsFooter
        elementNamesWithoutReference={[...namesWithoutReference.values()]}
        generateImagePromptsCredits={requiredCredits}
        onGenerateImagePromptsClick={openModal}
        generateDisabled={modalPhase === 'submitting'}
      />
      <ImagePromptsConfirmModal
        open={modalPhase !== 'closed'}
        phase={modalPhase === 'insufficient' ? 'insufficient' : 'confirm'}
        submitting={modalPhase === 'submitting'}
        requiredCredits={requiredCredits}
        balanceCredits={insufficient?.balance ?? null}
        onConfirm={confirm}
        onCancel={cancel}
      />
    </>
  )
}
