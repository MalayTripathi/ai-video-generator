'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { creditsFor } from '@/lib/config/credits'
import { stepIndex } from '@/lib/config/pipeline'
import { useShots } from './shots-context'
import { ShotsFooter, GoToImagePromptsFooter } from './shots-footer'
import { AdvanceConfirmModal } from '@/components/advance-confirm-modal'
import { getProjectFurthestStep } from '../actions'

type ModalPhase = 'closed' | 'confirm' | 'submitting' | 'insufficient'

// Shared across all three Workbench tabs (Shots, Assets, Script) - one implementation.
//
// Two states, decided by furthest_step alone - never by whether prompts exist. At the
// Workbench the click is the one that leads to a charge (confirm, balance check, advance).
// Past it the step is already unlocked, so the click is plain navigation and must never be
// blocked on balance: a project that advanced but has no prompts (a failed generation)
// still just navigates, and Step 3's own empty state and Regenerate All - behind the
// route's real balance gate - handle regeneration from there.
export function WorkbenchFooter({ projectId, furthestStep }: { projectId: string; furthestStep: number }) {
  const [advancedSince, setAdvancedSince] = useState(false)

  if (furthestStep > stepIndex('workbench') || advancedSince) {
    return <GoToImagePromptsFooter href={`/projects/${projectId}/image_prompts`} />
  }
  return <GenerateImagePromptsFooter onAdvancedSince={() => setAdvancedSince(true)} />
}

// Only elements attached to at least one shot count: an unbound element's missing
// reference can't affect any output, so counting it would be a warning nobody can act on.
function GenerateImagePromptsFooter({ onAdvancedSince }: { onAdvancedSince: () => void }) {
  const router = useRouter()
  const { projectId, shots } = useShots()

  // The furthest_step this page was rendered with can be stale: Back restores it from the
  // router cache with no request, and another tab may have advanced the project. While
  // showing the charging button, confirm the real value once; if the project has moved on,
  // fall to the plain link. (The advance route also never gates an already-advanced project
  // on balance, so a click in the moment before this returns still cannot be blocked.)
  useEffect(() => {
    let cancelled = false
    getProjectFurthestStep(projectId)
      .then((actual) => {
        if (!cancelled && actual !== null && actual > stepIndex('workbench')) onAdvancedSince()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

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
      <AdvanceConfirmModal
        open={modalPhase !== 'closed'}
        phase={modalPhase === 'insufficient' ? 'insufficient' : 'confirm'}
        submitting={modalPhase === 'submitting'}
        title="Generate image prompts?"
        body={`This starts writing image prompts for every shot and uses ${requiredCredits} credits.`}
        bannerTitle="Not enough credits for image prompts"
        confirmLabel="Generate"
        requiredCredits={requiredCredits}
        balanceCredits={insufficient?.balance ?? null}
        onConfirm={confirm}
        onCancel={cancel}
      />
    </>
  )
}
