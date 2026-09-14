'use client'

import { useAssets } from './assets-context'

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// The Assets-tab footer (canvas 12A). Unlike ShotsFooter, the warning counts every
// project element without a reference (not only shot-bound ones), and there is no
// bulk action beside it - "Add references" and its confirm (12F) are cut (prompt: "That
// control was cut. The footer keeps its warning text with no action attached.").
export function AssetsFooter() {
  const { groups, generateCredits, hasInsufficientBalance } = useAssets()

  const namesWithoutReference = groups
    .flatMap((group) => group.elements)
    .filter((el) => !el.reference_image_path)
    .map((el) => el.name)

  const shown = namesWithoutReference.slice(0, 3)
  const suffix = namesWithoutReference.length > 3 ? '…' : ''

  return (
    <>
      <div className="text-small leading-[1.5] text-text-secondary" data-testid="assets-footer-warning">
        {hasInsufficientBalance ? (
          <>
            Your balance is too low to generate reference images ({generateCredits} credits each). Upload stays
            available for any element.
          </>
        ) : (
          namesWithoutReference.length > 0 && (
            <>
              <span className="font-medium text-banner-active-title">
                {namesWithoutReference.length} element{namesWithoutReference.length === 1 ? '' : 's'} without a
                reference image
              </span>{' '}
              ({shown.join(', ')}
              {suffix}). They&rsquo;ll be written from their descriptions — fine, just less consistent.
            </>
          )
        )}
      </div>
      <div className="flex flex-none gap-rc-sm">
        <span className="flex h-9 cursor-not-allowed items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent opacity-60">
          Generate Image Prompts
          <ArrowIcon />
        </span>
      </div>
    </>
  )
}
