import { TopBar } from './top-bar'

function ProjectCardSkeleton() {
  return (
    <div className="flex flex-col gap-rc-sm rounded-control border border-border-subtle bg-bg-surface p-rc-sm pb-[14px]">
      <div className="aspect-video rounded-badge bg-bg-well" />
      <div className="flex flex-col gap-[10px]">
        <div className="h-4 w-2/3 rounded-badge bg-bg-well" />
        <div className="h-4 w-16 rounded-badge bg-bg-well" />
      </div>
    </div>
  )
}

export default function DashboardLoading() {
  return (
    <>
      <TopBar
        left={
          <h1 className="text-screen font-medium tracking-tight text-text-primary">
            Your projects
          </h1>
        }
      />
      <div className="grid grid-cols-1 gap-rc-lg px-rc-lg py-rc-lg pb-rc-2xl md:grid-cols-2 lg:px-rc-xl xl:grid-cols-3 xl:px-rc-2xl">
        {Array.from({ length: 6 }).map((_, i) => (
          <ProjectCardSkeleton key={i} />
        ))}
      </div>
    </>
  )
}
