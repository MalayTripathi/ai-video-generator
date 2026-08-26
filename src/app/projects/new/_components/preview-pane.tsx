export function PreviewPane() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 flex-none items-center gap-rc-lg border-b border-border-subtle px-rc-xl">
        <span className="text-small text-text-tertiary">Shots</span>
        <span className="text-small text-text-tertiary">Assets</span>
        <span className="text-small text-text-tertiary">Script</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-rc-lg overflow-y-auto p-rc-xl">
        <div className="flex flex-col items-center gap-rc-3xs rounded-badge border border-dashed border-border-muted px-rc-md py-rc-xl">
          <span className="text-small font-medium text-text-secondary">Your shot list appears here</span>
          <span className="text-meta text-text-tertiary">The agent fills this pane when you build</span>
        </div>
        {/* Flat, non-animated bars — the pane is decorative, never a loading state. */}
        <div aria-hidden className="flex flex-col gap-rc-sm">
          <span className="block h-[10px] w-[34%] rounded-[3px] bg-bg-inset" />
          <span className="block h-[10px] w-full rounded-[3px] bg-bg-inset" />
          <span className="block h-[10px] w-[64%] rounded-[3px] bg-bg-inset" />
        </div>
      </div>
    </div>
  )
}
