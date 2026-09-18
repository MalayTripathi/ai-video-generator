import { stepLabel } from '@/lib/config/pipeline'

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// Same footer chrome as workbench's ShotsFooter (border, sizing, button style) minus the
// "elements without a reference image" warning - that message is specific to the workbench
// generate-trigger and doesn't apply here. Visual placeholder only: no action is wired yet,
// since there is no storyboard route/advance endpoint to send it to.
export function ImagePromptsFooter() {
  return (
    <div className="flex flex-1 justify-end gap-rc-sm">
      <button
        type="button"
        disabled
        className="flex h-9 cursor-pointer items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        Continue to {stepLabel('storyboard')}
        <ArrowIcon />
      </button>
    </div>
  )
}
