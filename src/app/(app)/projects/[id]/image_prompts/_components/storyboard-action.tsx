'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AdvanceConfirmModal } from '@/components/advance-confirm-modal'
import { creditsFor } from '@/lib/config/credits'
import { stepIndex, stepLabel } from '@/lib/config/pipeline'
import { getProjectFurthestStep } from '../../workbench/actions'
import { useImagePrompts } from './image-prompts-context'

const PRIMARY_BUTTON_CLASSNAME =
  'flex h-9 flex-none cursor-pointer items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent disabled:cursor-not-allowed disabled:opacity-60'

type ModalPhase = 'closed' | 'confirm' | 'submitting' | 'insufficient'

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// Two states, decided by furthest_step alone - never by whether the storyboard has any
// content. At Image Prompts the click is the one that leads to a charge (confirm, balance
// check, advance). Past it the step is already unlocked, so the click is plain navigation
// and must never be blocked on balance - same rule as the Workbench footer.
export function StoryboardAction({ furthestStep, generating }: { furthestStep: number; generating: boolean }) {
  const { projectId } = useImagePrompts()
  const [advancedSince, setAdvancedSince] = useState(false)

  if (furthestStep > stepIndex('image_prompts') || advancedSince) {
    return (
      <Link href={`/projects/${projectId}/storyboard`} className={PRIMARY_BUTTON_CLASSNAME}>
        Go to {stepLabel('storyboard')}
        <ArrowIcon />
      </Link>
    )
  }
  return <ContinueToStoryboardButton generating={generating} onAdvancedSince={() => setAdvancedSince(true)} />
}

function ContinueToStoryboardButton({
  generating,
  onAdvancedSince,
}: {
  generating: boolean
  onAdvancedSince: () => void
}) {
  const router = useRouter()
  const { projectId, shots } = useImagePrompts()

  // The furthest_step this page was rendered with can be stale (Back restores it from the
  // router cache with no request; another tab may have advanced the project). While showing
  // the charging button, confirm the real value once and fall to the plain link if the
  // project has moved on. The advance route never gates an already-advanced project on
  // balance either, so a click in the moment before this returns still cannot be blocked.
  useEffect(() => {
    let cancelled = false
    getProjectFurthestStep(projectId)
      .then((actual) => {
        if (!cancelled && actual !== null && actual > stepIndex('image_prompts')) onAdvancedSince()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const [modalPhase, setModalPhase] = useState<ModalPhase>('closed')
  const [insufficient, setInsufficient] = useState<{ required: number; balance: number } | null>(null)

  // Display-only, reactive to the live shot count; the route recomputes its own
  // authoritative quantity from a fresh DB read.
  const requiredCredits = creditsFor({ step: 'storyboard', operation: 'generate_image', quantity: shots.length })

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
      const res = await fetch(`/api/projects/${projectId}/storyboard/advance`, { method: 'POST' })
      const body = await res.json()

      if (res.ok && body.ok) {
        router.push(`/projects/${projectId}/storyboard`)
        return
      }

      if (res.status === 402) {
        setInsufficient({ required: body.requiredCredits, balance: body.balanceCredits })
        setModalPhase('insufficient')
        return
      }

      console.error('[image-prompts] advance to storyboard failed', body)
      setModalPhase('confirm')
    } catch (err) {
      console.error('[image-prompts] advance to storyboard request failed', err)
      setModalPhase('confirm')
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        disabled={generating || modalPhase === 'submitting'}
        className={PRIMARY_BUTTON_CLASSNAME}
      >
        Create Storyboard — {requiredCredits} Credits
        <ArrowIcon />
      </button>
      <AdvanceConfirmModal
        open={modalPhase !== 'closed'}
        phase={modalPhase === 'insufficient' ? 'insufficient' : 'confirm'}
        submitting={modalPhase === 'submitting'}
        title="Continue to storyboard?"
        body={`Generating the storyboard images uses ${requiredCredits} credits, charged when you generate them. Once you continue, your shots and image prompts become read-only.`}
        bannerTitle="Not enough credits for the storyboard"
        confirmLabel="Continue"
        requiredCredits={insufficient?.required ?? requiredCredits}
        balanceCredits={insufficient?.balance ?? null}
        onConfirm={confirm}
        onCancel={cancel}
      />
    </>
  )
}
