import { createProject } from './actions'

export function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center px-rc-lg py-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
      <div className="flex max-w-sm flex-col items-center gap-rc-sm rounded-frame border border-dashed border-border-muted bg-bg-well px-rc-xl py-rc-2xl text-center">
        <div className="flex flex-col gap-rc-2xs">
          <h2 className="text-section font-medium tracking-snug text-text-primary">
            No projects yet
          </h2>
          <p className="text-ui text-text-secondary">
            Start with a topic and Reelcraft will draft your first script.
          </p>
        </div>
        <form action={createProject} className="mt-rc-xs">
          <button
            type="submit"
            data-testid="new-project-empty"
            className="flex h-10 cursor-pointer items-center justify-center gap-rc-xs rounded-control border border-accent bg-transparent px-rc-md text-control font-medium text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <rect x="5.75" y="1" width="1.5" height="11" fill="currentColor" />
              <rect x="1" y="5.75" width="11" height="1.5" fill="currentColor" />
            </svg>
            New project
          </button>
        </form>
      </div>
    </div>
  )
}
