function Bar({ className }: { className: string }) {
  return <span className={`inline-block rounded-[3px] bg-skeleton-base ${className}`} />
}

// The same chrome skeleton as Step 3's loading state, with a plain content pane: the
// storyboard has no content to shape a skeleton after yet.
export default function StoryboardLoading() {
  return (
    <>
      <div className="flex-none border-b border-border-subtle px-rc-md py-rc-md">
        <div className="flex flex-col gap-rc-sm">
          <Bar className="h-5 w-56" />
          <div className="flex gap-rc-2xs">
            <Bar className="h-6 w-16 rounded-full" />
            <Bar className="h-6 w-20 rounded-full" />
            <Bar className="h-6 w-14 rounded-full" />
          </div>
        </div>
      </div>

      <div className="flex h-[50px] flex-none items-center gap-rc-lg overflow-hidden border-b border-border-subtle px-rc-md">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex flex-none items-center gap-[9px]">
            <span className="h-[22px] w-[22px] flex-none rounded-badge bg-skeleton-base" />
            <Bar className="h-[10px] w-14" />
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[330px] min-w-[280px] flex-none flex-col border-r border-border-subtle">
          <div className="flex-none border-b border-border-subtle px-rc-md pb-rc-sm pt-rc-md">
            <Bar className="h-4 w-16" />
          </div>
          <div className="flex flex-1 flex-col gap-rc-sm px-rc-md py-rc-sm">
            <Bar className="h-9 w-[85%]" />
            <Bar className="h-9 w-[70%]" />
          </div>
          <div className="flex-none border-t border-border-subtle px-rc-md py-rc-sm">
            <div className="h-[38px] w-full rounded-control bg-skeleton-base" />
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-rc-md py-rc-md">
          <Bar className="h-24 w-72 rounded-frame" />
        </div>
      </div>

      <div className="flex h-16 flex-none items-center justify-between gap-rc-lg border-t border-border-subtle bg-bg-surface px-rc-md">
        <Bar className="h-3 w-40" />
        <Bar className="h-9 w-44 rounded-control" />
      </div>
    </>
  )
}
