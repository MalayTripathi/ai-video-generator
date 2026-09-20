import Link from 'next/link'
import { stepLabel } from '@/lib/config/pipeline'

const PRIMARY_BUTTON_CLASSNAME =
  'flex h-9 cursor-pointer items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent disabled:cursor-not-allowed disabled:opacity-60'

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function ShotsFooter({
  elementNamesWithoutReference,
  generateImagePromptsCredits,
  onGenerateImagePromptsClick,
  generateDisabled,
}: {
  elementNamesWithoutReference: string[]
  generateImagePromptsCredits: number
  onGenerateImagePromptsClick: () => void
  generateDisabled?: boolean
}) {
  const shown = elementNamesWithoutReference.slice(0, 3)
  const suffix = elementNamesWithoutReference.length > 3 ? '…' : ''

  return (
    <>
      <div className="text-small leading-[1.5] text-text-secondary" data-testid="workbench-footer-warning">
        {elementNamesWithoutReference.length > 0 && (
          <>
            <span className="font-medium text-banner-active-title">
              {elementNamesWithoutReference.length} element{elementNamesWithoutReference.length === 1 ? '' : 's'}{' '}
              without a reference image
            </span>{' '}
            ({shown.join(', ')}
            {suffix}). They&rsquo;ll be written from their descriptions — fine, just less consistent.
          </>
        )}
      </div>
      <div className="flex flex-none gap-rc-sm">
        <button
          type="button"
          onClick={onGenerateImagePromptsClick}
          disabled={generateDisabled}
          className={PRIMARY_BUTTON_CLASSNAME}
        >
          Generate Image Prompts - {generateImagePromptsCredits} Credits
          <ArrowIcon />
        </button>
      </div>
    </>
  )
}

// Once a project has advanced past the Workbench the step is already unlocked, so this is
// plain navigation: a real link, no credit figure, no confirmation, no balance check and
// no advanceStep(). Nothing here can lead to a charge. The elements-without-a-reference
// warning is about what generation would write, so it is not shown - the slot stays so
// the button keeps its place on the right.
export function GoToImagePromptsFooter({ href }: { href: string }) {
  return (
    <>
      <div className="text-small leading-[1.5] text-text-secondary" data-testid="workbench-footer-warning" />
      <div className="flex flex-none gap-rc-sm">
        <Link href={href} className={PRIMARY_BUTTON_CLASSNAME}>
          Go to {stepLabel('image_prompts')}
          <ArrowIcon />
        </Link>
      </div>
    </>
  )
}
