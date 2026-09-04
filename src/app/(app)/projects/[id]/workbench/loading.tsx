function Bar({ className }: { className: string }) {
  return <span className={`inline-block rounded-[3px] bg-skeleton-base ${className}`} />
}

function ShotCardSkeleton() {
  return (
    <div className="flex flex-col gap-rc-xs rounded-control border border-border-subtle bg-bg-surface p-3 px-rc-md">
      <Bar className="h-[11px] w-20" />
      <Bar className="h-[13px] w-[70%]" />
      <Bar className="h-[11px] w-[50%]" />
    </div>
  )
}

export default function WorkbenchLoading() {
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

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-[42px] flex-none items-center gap-rc-lg border-b border-border-subtle px-rc-md">
            <Bar className="h-3 w-10" />
            <Bar className="h-3 w-12" />
            <Bar className="h-3 w-10" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-rc-sm overflow-hidden px-rc-md py-rc-md">
            <ShotCardSkeleton />
            <ShotCardSkeleton />
            <ShotCardSkeleton />
          </div>
        </div>
      </div>

      <div className="flex h-16 flex-none items-center justify-between gap-rc-lg border-t border-border-subtle bg-bg-surface px-rc-md">
        <Bar className="h-3 w-40" />
        <Bar className="h-9 w-32 rounded-control" />
      </div>
    </>
  )
}
