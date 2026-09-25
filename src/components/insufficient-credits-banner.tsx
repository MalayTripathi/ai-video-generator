import { formatCredits } from '@/lib/format-credits'

type BannerAction = { label: string; credits: number; onClick: () => void; disabled?: boolean }

// The one insufficient-balance banner. Rendered inside the Workbench's "Generate image
// prompts?" modal, on Step 3 when a regeneration is refused for balance, and on the
// Storyboard - a second copy would drift. `balanceCredits` is null only when the caller
// genuinely has no figure.
//
// Case 2 (canvas 15c d, "not enough credits for the last N"): the caller passes its own
// `body` and an `action` - some of the work is affordable, so the banner offers to do
// that part (priced) instead of the disabled Add credits.
export function InsufficientCreditsBanner({
  title,
  subject = 'This step',
  requiredCredits,
  balanceCredits,
  body,
  action,
}: {
  title: string
  subject?: string
  requiredCredits: number
  balanceCredits: number | null
  body?: string
  action?: BannerAction
}) {
  return (
    <div
      role="alert"
      className={`flex gap-rc-sm rounded-control border-l-2 border-status-active-fg bg-status-active-bg ${
        action ? 'items-center p-[13px_15px]' : 'items-start p-[14px_16px]'
      }`}
    >
      <div className={`flex flex-1 flex-col ${action ? 'gap-[4px] pl-rc-2xs' : 'gap-[3px]'}`}>
        <span className={`font-medium text-banner-active-title ${action ? 'text-ui' : 'text-control'}`}>{title}</span>
        <span className="text-small leading-[1.5] text-banner-active-body">
          {body ??
            (balanceCredits === null
              ? `${subject} needs ${requiredCredits} credits.`
              : `${subject} needs ${requiredCredits} credits. You have ${balanceCredits} credits available.`)}
        </span>
      </div>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          className="flex h-8 flex-none cursor-pointer items-center gap-rc-xs whitespace-nowrap rounded-control border border-accent px-rc-sm text-small leading-none font-medium text-accent hover:bg-status-active-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {action.label}
          <span className="font-mono text-mono font-normal">{formatCredits(action.credits)} cr</span>
        </button>
      ) : (
        <button
          type="button"
          disabled
          className="flex h-8 flex-none cursor-not-allowed items-center rounded-control border border-accent bg-bg-surface px-rc-sm text-small font-medium text-accent opacity-60 hover:bg-status-active-bg-hover"
        >
          Add credits
        </button>
      )}
    </div>
  )
}
