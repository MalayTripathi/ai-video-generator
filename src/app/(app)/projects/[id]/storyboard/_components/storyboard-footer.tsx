'use client'

import { stepLabel } from '@/lib/config/pipeline'
import { useStoryboard } from './storyboard-context'

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// Continue stays inert: there is no Video Prompts route or advance endpoint to send it to
// yet, so it is deliberately not offered as an enabled control. The clip count is the lane's:
// a binned shot is not a clip.
export function StoryboardFooter() {
  const { laneShots } = useStoryboard()
  const clips = laneShots.length
  return (
    <>
      <span className="text-small leading-[1.5] text-text-secondary">Motion prompts are written after frames exist.</span>
      <button
        type="button"
        disabled
        className="flex h-9 flex-none cursor-pointer items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span data-testid="continue-label">
          Continue to {stepLabel('video_prompts')} ({clips} {clips === 1 ? 'clip' : 'clips'})
        </span>
        <ArrowIcon />
      </button>
    </>
  )
}
