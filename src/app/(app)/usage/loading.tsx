import { TopBar } from '../dashboard/top-bar'

function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <section className="rounded-control border border-border-subtle bg-bg-surface p-rc-lg shadow-card">
      <div className="h-5 w-32 rounded-badge bg-bg-well" />
      <div className="mt-rc-md flex flex-col gap-rc-sm">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 w-full rounded-badge bg-bg-well" />
        ))}
      </div>
    </section>
  )
}

export default function UsageLoading() {
  return (
    <>
      <TopBar left={<h1 className="text-screen font-medium tracking-tight text-text-primary">Usage</h1>} />
      <div className="flex flex-1 flex-col gap-rc-lg px-rc-lg py-rc-lg pb-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
        <SectionSkeleton rows={3} />
        <SectionSkeleton rows={3} />
        <SectionSkeleton rows={2} />
      </div>
    </>
  )
}
