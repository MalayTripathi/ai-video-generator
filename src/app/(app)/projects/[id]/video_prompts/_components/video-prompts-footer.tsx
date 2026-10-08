const PRIMARY_BUTTON_CLASSNAME =
  'flex h-9 flex-none cursor-pointer items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent disabled:cursor-not-allowed disabled:opacity-60'

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// Continue stays inert: there is no Generation route or advance endpoint to send it to yet,
// so it is deliberately not offered as an enabled control.
export function VideoPromptsFooter() {
  return (
    <>
      <span />
      <button type="button" disabled className={PRIMARY_BUTTON_CLASSNAME}>
        Continue to generation
        <ArrowIcon />
      </button>
    </>
  )
}
