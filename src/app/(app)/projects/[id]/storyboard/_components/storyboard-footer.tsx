'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AdvanceConfirmModal } from '@/components/advance-confirm-modal'
import { creditsFor } from '@/lib/config/credits'
import { stepIndex, stepLabel } from '@/lib/config/pipeline'
import { musicShorterThanPicture } from '@/lib/music/length'
import { formatTimecode } from '@/lib/storyboard/timeline'
import { voiceoverLengthDiffers } from '@/lib/storyboard/voiceover'
import { getProjectFurthestStep } from '../../workbench/actions'
import { shorterMessage } from './music-card'
import { useStoryboard } from './storyboard-context'

const PRIMARY_BUTTON_CLASSNAME =
  'flex h-9 flex-none cursor-pointer items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent disabled:cursor-not-allowed disabled:opacity-60'

type ModalPhase = 'closed' | 'checking' | 'confirm' | 'submitting' | 'insufficient'

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// Two states, decided by furthest_step alone - same rule as the Workbench footer. At the
// Storyboard the click is the one that leads to a charge (confirm, balance check, advance).
// Past it the step is already unlocked, so the click is plain navigation and must never be
// blocked on balance. Voiceover, music and export are optional: none of them gates Continue.
export function StoryboardFooter({ furthestStep }: { furthestStep: number }) {
  const { projectId } = useStoryboard()
  const [advancedSince, setAdvancedSince] = useState(false)

  return (
    <>
      <span className="text-small leading-[1.5] text-text-secondary">Motion prompts are written after frames exist.</span>
      {furthestStep > stepIndex('storyboard') || advancedSince ? (
        <Link
          href={`/projects/${projectId}/video_prompts`}
          data-testid="go-to-video-prompts"
          className={PRIMARY_BUTTON_CLASSNAME}
        >
          Go to {stepLabel('video_prompts')}
          <ArrowIcon />
        </Link>
      ) : (
        <GenerateVideoPromptsButton onAdvancedSince={() => setAdvancedSince(true)} />
      )}
    </>
  )
}

function GenerateVideoPromptsButton({ onAdvancedSince }: { onAdvancedSince: () => void }) {
  const router = useRouter()
  const { projectId, laneShots, statusFor, framesReady, film, voiceover, voiceoverStaleness, music } = useStoryboard()

  const [modalPhase, setModalPhase] = useState<ModalPhase>('closed')
  const [insufficient, setInsufficient] = useState<{ required: number; balance: number } | null>(null)

  // Display-only, over the in-film shots (a binned shot is not a clip); the route recomputes
  // its own authoritative quantity from a fresh DB read.
  const shotCount = laneShots.length
  const requiredCredits = creditsFor({ step: 'video_prompts', operation: 'write_video_prompts', quantity: shotCount })

  // Warnings only - each names something imperfect that is carried forward as it is, and
  // none of them blocks Confirm.
  const pictureSec = film.totalSec
  const staleFrames = laneShots.filter((shot) => statusFor(shot.id).state === 'stale').length
  const warnings: string[] = []
  if (staleFrames > 0) {
    warnings.push(
      `${staleFrames} ${staleFrames === 1 ? 'frame is' : 'frames are'} stale — video prompts will be written from ${staleFrames === 1 ? 'it' : 'them'} as ${staleFrames === 1 ? 'it is' : 'they are'}.`
    )
  }
  if (voiceover.current && voiceoverStaleness?.stale) {
    warnings.push('The voiceover is stale — it no longer matches the shots in the film.')
  }
  if (voiceover.current && voiceoverLengthDiffers(voiceover.current.durationSec, pictureSec)) {
    warnings.push(
      `The voiceover is ${formatTimecode(voiceover.current.durationSec)} and the picture is ${formatTimecode(pictureSec)} — they differ in length.`
    )
  }
  if (music.current && musicShorterThanPicture(music.current.durationSec, pictureSec, music.current.loop)) {
    warnings.push(shorterMessage(music.current.durationSec, pictureSec))
  }

  // The furthest_step this page was rendered with can be stale (Back restores it from the
  // router cache with no request; another tab may have advanced the project). Confirm the
  // real value on click - not on mount, so an ordinary page load sends no server action -
  // and go straight to the reached step, unpriced, if the project has moved on. The advance
  // route never gates an already-advanced project on balance either.
  async function openModal() {
    setInsufficient(null)
    setModalPhase('checking')
    const actual = await getProjectFurthestStep(projectId).catch(() => null)
    if (actual !== null && actual > stepIndex('storyboard')) {
      setModalPhase('closed')
      onAdvancedSince()
      router.push(`/projects/${projectId}/video_prompts`)
      return
    }
    setModalPhase('confirm')
  }

  function cancel() {
    setModalPhase('closed')
    setInsufficient(null)
  }

  async function confirm() {
    setModalPhase('submitting')
    try {
      const res = await fetch(`/api/projects/${projectId}/video_prompts/advance`, { method: 'POST' })
      const body = await res.json()

      if (res.ok && body.ok) {
        router.push(`/projects/${projectId}/video_prompts`)
        return
      }

      if (res.status === 402) {
        setInsufficient({ required: body.requiredCredits, balance: body.balanceCredits })
        setModalPhase('insufficient')
        return
      }

      console.error('[storyboard] advance to video prompts failed', body)
      setModalPhase('confirm')
    } catch (err) {
      console.error('[storyboard] advance to video prompts request failed', err)
      setModalPhase('confirm')
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="generate-video-prompts"
        onClick={openModal}
        // Every in-film frame must have an image with nothing in flight; the route refuses
        // the same.
        disabled={!framesReady || shotCount === 0 || modalPhase === 'checking' || modalPhase === 'submitting'}
        className={PRIMARY_BUTTON_CLASSNAME}
      >
        Generate Video Prompts — {requiredCredits} Credits
        <ArrowIcon />
      </button>
      <AdvanceConfirmModal
        open={modalPhase !== 'closed' && modalPhase !== 'checking'}
        phase={modalPhase === 'insufficient' ? 'insufficient' : 'confirm'}
        submitting={modalPhase === 'submitting'}
        title="Generate video prompts?"
        body={`Writing video prompts for the ${shotCount} ${shotCount === 1 ? 'shot' : 'shots'} in the film uses ${requiredCredits} credits. The storyboard stays editable.`}
        warning={warnings}
        bannerTitle="Not enough credits for video prompts"
        confirmLabel="Generate"
        requiredCredits={insufficient?.required ?? requiredCredits}
        balanceCredits={insufficient?.balance ?? null}
        onConfirm={confirm}
        onCancel={cancel}
      />
    </>
  )
}
