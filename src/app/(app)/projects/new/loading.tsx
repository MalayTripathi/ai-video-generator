import { TopBar } from '@/app/(app)/dashboard/top-bar'

function Bar({ className }: { className: string }) {
  return <div className={`rounded-badge bg-bg-well ${className}`} />
}

export default function NewProjectLoading() {
  return (
    <>
      <TopBar left={<span />} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-[420px] flex-none flex-col gap-rc-lg overflow-y-auto px-rc-xl py-rc-xl">
          <div className="flex flex-col gap-rc-2xs">
            <Bar className="h-6 w-[60%]" />
            <Bar className="h-4 w-[40%]" />
          </div>

          <div className="flex flex-wrap gap-rc-xs">
            <div className="h-7 w-24 rounded-full bg-bg-well" />
            <div className="h-7 w-32 rounded-full bg-bg-well" />
            <div className="h-7 w-20 rounded-full bg-bg-well" />
          </div>

          <div className="min-h-[130px] rounded-badge bg-bg-well" />

          <Bar className="h-[38px] w-full" />

          <div className="grid grid-cols-3 gap-rc-sm">
            <div className="h-[96px] rounded-control bg-bg-well" />
            <div className="h-[96px] rounded-control bg-bg-well" />
            <div className="h-[96px] rounded-control bg-bg-well" />
          </div>

          <div className="grid grid-cols-2 gap-rc-sm">
            <div className="h-[56px] rounded-control bg-bg-well" />
            <div className="h-[56px] rounded-control bg-bg-well" />
          </div>

          <div className="flex flex-col gap-rc-2xs">
            <Bar className="h-4 w-24" />
            <div className="h-11 w-full rounded-control bg-bg-well" />
          </div>
        </div>

        <div className="w-px flex-none bg-border-subtle" />

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-11 flex-none items-center gap-rc-lg border-b border-border-subtle px-rc-xl">
            <Bar className="h-3 w-10" />
            <Bar className="h-3 w-10" />
            <Bar className="h-3 w-10" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-rc-lg p-rc-xl">
            <div className="h-[92px] rounded-badge border border-dashed border-border-muted" />
            <div className="flex flex-col gap-rc-sm">
              <Bar className="h-[10px] w-[34%]" />
              <Bar className="h-[10px] w-full" />
              <Bar className="h-[10px] w-[64%]" />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
