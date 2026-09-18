// The one insufficient-balance banner. Rendered inside the Workbench's "Generate image
// prompts?" modal and on Step 3 when a regeneration is refused for balance - a second
// copy would drift. `balanceCredits` is null only when the caller genuinely has no figure.
export function InsufficientCreditsBanner({
  title,
  subject = 'This step',
  requiredCredits,
  balanceCredits,
}: {
  title: string
  subject?: string
  requiredCredits: number
  balanceCredits: number | null
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-rc-sm rounded-control border-l-2 border-status-active-fg bg-status-active-bg p-[14px_16px]"
    >
      <div className="flex flex-1 flex-col gap-[3px]">
        <span className="text-control font-medium text-banner-active-title">{title}</span>
        <span className="text-small leading-[1.5] text-banner-active-body">
          {balanceCredits === null
            ? `${subject} needs ${requiredCredits} credits.`
            : `${subject} needs ${requiredCredits} credits. You have ${balanceCredits} credits available.`}
        </span>
      </div>
      <button
        type="button"
        disabled
        className="flex h-8 flex-none cursor-not-allowed items-center rounded-control border border-accent bg-bg-surface px-rc-sm text-small font-medium text-accent opacity-60 hover:bg-status-active-bg-hover"
      >
        Add credits
      </button>
    </div>
  )
}
