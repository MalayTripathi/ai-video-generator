'use client'

import { InsufficientCreditsBanner } from '@/components/insufficient-credits-banner'
import { caseTwo, readiness } from '@/lib/storyboard/timeline'
import { imagePrice, useStoryboard } from './storyboard-context'
import { TimelineCard } from './timeline-card'
import { MotionPanels } from './motion-panels'
import { MusicSection } from './audio-sections'
import { VoiceoverCard } from './voiceover-card'
import { ExportLocked, PreviewLocked } from './locked-sections'
import { OrderDiffersBanner } from './order-differs-banner'

// The Storyboard main column (canvas 15a): Timeline, the two audio lane controls, then
// Preview & mix and Export. Its width never changes - the inspect panel takes the agent's
// column instead.
export function StoryboardMain({ language }: { language: string | null }) {
  const {
    laneShots,
    statusFor,
    balanceCredits,
    polling,
    actionError,
    readOnly,
    busyShotIds,
    generate,
    voiceover,
    voiceoverOrderDiffers,
    fitClamped,
  } = useStoryboard()

  // Binned shots are off the film: the counter, Preview lock, Export and Generate remaining
  // all read the lane alone.
  const statuses = laneShots.map((s) => statusFor(s.id))
  const r = readiness(statuses.map((s) => s.state))
  const notGeneratedIds = statuses.filter((s) => s.state === 'not_generated').map((s) => s.shotId)
  const banner = caseTwo(r, balanceCredits, imagePrice(1))
  const laneError = actionError?.source === 'lane' ? actionError : null

  return (
    <div
      data-testid="storyboard-main"
      className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-rc-md pb-[22px] pt-[20px]"
    >
      <div className="flex flex-none flex-col gap-[12px]">
        <div className="flex items-baseline gap-[12px]">
          <span className="text-screen font-medium tracking-snug">Timeline</span>
          <span className="flex-1 text-meta text-text-tertiary">
            {polling
              ? 'Frames are arriving. Lengths and order are yours to set now.'
              : 'One strip, two modes — lengths and order here, motion and transitions in the other.'}
          </span>
          <span data-testid="frames-ready" className="flex flex-none items-center gap-[7px] text-small text-text-secondary">
            <span
              className={`h-[5px] w-[5px] rounded-full ${r.ready === r.total ? 'bg-status-done-fg' : 'bg-status-draft-fg'}`}
            />
            {r.ready} of {r.total} frames ready
          </span>
        </div>

        <TimelineCard />

        <MotionPanels />

        {fitClamped && (
          <span data-testid="fit-note" className="text-meta text-text-tertiary">
            {fitClamped.length === 1 ? `Shot ${fitClamped[0]} was` : `Shots ${fitClamped.join(', ')} were`} held to the
            allowed length, so {fitClamped.length === 1 ? 'it doesn’t' : 'they don’t'} match the narration exactly.
          </span>
        )}

        {voiceover.current && voiceoverOrderDiffers && <OrderDiffersBanner />}

        {banner && (
          <InsufficientCreditsBanner
            title={banner.title}
            body={banner.body}
            requiredCredits={banner.requiredCredits}
            balanceCredits={balanceCredits}
            action={{
              label: 'Generate remaining',
              credits: imagePrice(banner.shotCount),
              onClick: () => void generate(notGeneratedIds, 'lane'),
              disabled: readOnly || notGeneratedIds.some((id) => busyShotIds.has(id)),
            }}
          />
        )}
        {laneError?.kind === 'credits' && !banner && (
          <InsufficientCreditsBanner
            title={laneError.title}
            subject="This"
            requiredCredits={laneError.requiredCredits}
            balanceCredits={laneError.balanceCredits}
          />
        )}
        {laneError?.kind === 'error' && (
          <span role="alert" className="text-small text-status-failed-fg">
            {laneError.message}
          </span>
        )}

        <div className="flex flex-col gap-[8px]">
          <VoiceoverCard language={language} />
          <MusicSection />
        </div>
      </div>

      <PreviewLocked readiness={r} />
      <ExportLocked readiness={r} />
    </div>
  )
}
