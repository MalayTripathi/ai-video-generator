export function AssetsTab() {
  return (
    <div className="flex flex-col items-center gap-rc-xs rounded-control border border-dashed border-border-strong p-rc-lg text-center">
      <span className="text-body font-medium text-text-primary">No elements yet</span>
      <span className="max-w-[420px] text-small leading-[1.5] text-text-secondary">
        Elements are the characters, locations and props your shots share. They keep a face the same across
        shots. The agent writes them from your script — or add your own.
      </span>
      <div className="mt-rc-2xs flex gap-rc-xs">
        <span className="flex h-8 cursor-not-allowed items-center rounded-control border border-border-strong px-rc-sm text-small opacity-60">
          Upload reference
        </span>
        <span className="flex h-8 cursor-not-allowed items-center rounded-control border border-accent px-rc-sm text-small font-medium text-accent opacity-60">
          Generate with AI
        </span>
      </div>
    </div>
  )
}
