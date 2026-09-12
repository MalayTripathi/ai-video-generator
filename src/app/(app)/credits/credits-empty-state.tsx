export function CreditsEmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center px-rc-lg py-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
      <div className="flex max-w-sm flex-col items-center gap-rc-2xs rounded-frame border border-dashed border-border-muted bg-bg-well px-rc-xl py-rc-2xl text-center">
        <h2 className="text-section font-medium tracking-snug text-text-primary">No credit activity yet</h2>
        <p className="text-ui text-text-secondary">
          Credits show up here once your account has a balance or a project spends some.
        </p>
      </div>
    </div>
  )
}
