function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function ShotsFooter({ elementNamesWithoutReference }: { elementNamesWithoutReference: string[] }) {
  const shown = elementNamesWithoutReference.slice(0, 3)
  const suffix = elementNamesWithoutReference.length > 3 ? '…' : ''

  return (
    <>
      <div className="text-small leading-[1.5] text-text-secondary">
        {elementNamesWithoutReference.length > 0 && (
          <>
            <span className="font-medium text-banner-active-title">
              {elementNamesWithoutReference.length} elements without a reference image
            </span>{' '}
            ({shown.join(', ')}
            {suffix}). They&rsquo;ll be written from their descriptions — fine, just less consistent.
          </>
        )}
      </div>
      <div className="flex flex-none gap-rc-sm">
        <span className="flex h-9 cursor-not-allowed items-center rounded-control border border-border-strong px-rc-md text-control opacity-60">
          Add references
        </span>
        <span className="flex h-9 cursor-not-allowed items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent opacity-60">
          Continue to voiceover
          <ArrowIcon />
        </span>
      </div>
    </>
  )
}
