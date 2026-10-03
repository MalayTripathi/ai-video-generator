import type { AspectRatio } from '@/lib/config/enums'
import { PromptCardSkeleton } from '../../image_prompts/_components/prompt-skeleton'

function Bar({ className }: { className: string }) {
  return <span className={`inline-block rounded-[3px] bg-skeleton-base ${className}`} />
}

// Step 5's render area until video-prompt generation is built: Step 3's skeleton pattern
// (streamed cards in the real card's shape, never a spinner over an empty page). Shared by
// the page body and loading.tsx so the two never drift. Server-renderable.
export function VideoPromptsSkeleton({ aspectRatio }: { aspectRatio?: AspectRatio }) {
  return (
    <div
      data-testid="video-prompts-placeholder"
      aria-hidden
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-rc-sm overflow-hidden px-rc-md py-rc-md"
    >
      <div className="flex flex-none items-center justify-between">
        <Bar className="h-3 w-40" />
        <span className="block h-[34px] w-36 rounded-control bg-skeleton-base" />
      </div>
      <div className="flex flex-col gap-[10px]">
        <PromptCardSkeleton aspectRatio={aspectRatio} badge={74} line2={92} line3={61} />
        <PromptCardSkeleton aspectRatio={aspectRatio} badge={46} line2={86} line3={44} />
        <PromptCardSkeleton aspectRatio={aspectRatio} badge={62} line2={95} line3={70} />
      </div>
    </div>
  )
}
