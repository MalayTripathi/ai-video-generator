'use client'

import { InsufficientCreditsBanner } from '@/components/insufficient-credits-banner'
import { caseTwo } from '@/lib/storyboard/timeline'
import { imagePrice, useStoryboard } from './storyboard-context'
import { TimelineCard } from './timeline-card'
import { MotionPanels } from './motion-panels'
import { MusicCard } from './music-card'
import { VoiceoverCard } from './voiceover-card'
import { ExportLocked, PreviewLocked } from './locked-sections'
import { ExportSection } from './export-section'
import { exportSummary } from '@/lib/export/settings'
import type { ExportsData } from '@/app/api/projects/[id]/exports/logic'
import { OrderDiffersBanner } from './order-differs-banner'
import { PreviewMix } from './preview-mix'
import { MiniPlayer } from './mini-player'

// The Storyboard main column (canvas 15a): Timeline, the two audio lane controls, then
// Preview & mix and Export. Its width never changes - the inspect panel takes the agent's
// column instead.
export function StoryboardMain({
  language,
  initialExports,
  initialMusicStylePrompt,
}: {
  language: string | null
  initialExports: ExportsData
  initialMusicStylePrompt: string | null
}) {
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
    frameReadiness: r,
    framesReady,
    aspectRatio,
    resolvedExport,
  } = useStoryboard()

  // Binned shots are off the film: the counter, Preview lock, Export and Generate remaining
  // all read the lane alone.
  const statuses = laneShots.map((s) => statusFor(s.id))
  const notGenerated = statuses.filter((s) => s.state === 'not_generated')
  const notGeneratedIds = notGenerated.map((s) => s.shotId)
  const banner = caseTwo(r, balanceCredits, imagePrice(notGenerated))
  const laneError = actionError?.source === 'lane' ? actionError : null

  return (
    // The wrapper holds the mini player still while the column scrolls under it.
    <div className="relative flex min-h-0 flex-1 flex-col">
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
              {fitClamped.length === 1 ? `Shot ${fitClamped[0]} was` : `Shots ${fitClamped.join(', ')} were`} held to the allowed
              length, so {fitClamped.length === 1 ? 'it doesn’t' : 'they don’t'} match the narration exactly.
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
                credits: banner.requiredCredits,
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
            <MusicCard initialStylePrompt={initialMusicStylePrompt} />
          </div>
        </div>

        {framesReady ? <PreviewMix /> : <PreviewLocked readiness={r} aspectRatio={aspectRatio} />}
        {framesReady ? (
          <ExportSection initialExports={initialExports} />
        ) : (
          <ExportLocked summary={exportSummary(resolvedExport)} />
        )}
      </div>
      <MiniPlayer />
    </div>
  )
}
