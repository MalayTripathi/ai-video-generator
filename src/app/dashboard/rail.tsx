import Link from 'next/link'

export function Rail() {
  return (
    <aside className="flex w-[244px] flex-none flex-col bg-rail-bg border-r border-rail-border px-rc-md pb-rc-md pt-rc-lg">
      <div className="flex items-center gap-[9px] px-rc-xs pb-rc-lg">
        <span className="block h-4 w-4 rounded-[3px] bg-accent" />
        <span className="text-body font-medium tracking-micro text-rail-fg">Reelcraft</span>
      </div>

      <Link
        href="/projects/new"
        data-testid="new-project-rail"
        className="mb-rc-lg flex h-[38px] w-full cursor-pointer items-center justify-center gap-rc-xs rounded-control border border-accent bg-transparent text-ui font-medium text-accent outline-none hover:bg-rail-item-active-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:border-accent-active active:bg-rail-item-active-bg active:text-accent-active"
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <rect x="5.75" y="1" width="1.5" height="11" fill="currentColor" />
          <rect x="1" y="5.75" width="11" height="1.5" fill="currentColor" />
        </svg>
        New Project
      </Link>

      <nav className="flex flex-col gap-[2px]">
        <div className="relative flex h-[34px] items-center gap-[10px] rounded-control bg-rail-item-active-bg px-[10px] text-ui font-medium text-rail-fg">
          <span className="absolute left-0 top-[11px] h-3 w-[2px] rounded-[1px] bg-accent" />
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="0.75" y="0.75" width="5" height="5" stroke="currentColor" strokeWidth="1.3" />
            <rect x="8.25" y="0.75" width="5" height="5" stroke="currentColor" strokeWidth="1.3" />
            <rect x="0.75" y="8.25" width="5" height="5" stroke="currentColor" strokeWidth="1.3" />
            <rect x="8.25" y="8.25" width="5" height="5" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Projects
        </div>

        <div className="flex h-[34px] items-center gap-[10px] rounded-control px-[10px] text-ui text-rail-fg-muted">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="0.75" y="3.75" width="8" height="8" stroke="currentColor" strokeWidth="1.3" />
            <path d="M4 3V1.25h8.25V10" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Assets
        </div>
        <div className="flex h-[34px] items-center gap-[10px] rounded-control px-[10px] text-ui text-rail-fg-muted">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="0.75" y="0.75" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
            <path d="M4.5 7h7M4.5 10.25h7" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Queue
        </div>
        <div className="flex h-[34px] items-center gap-[10px] rounded-control px-[10px] text-ui text-rail-fg-muted">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1" y="8" width="2.5" height="5" fill="currentColor" />
            <rect x="5.75" y="4.5" width="2.5" height="8.5" fill="currentColor" />
            <rect x="10.5" y="1.5" width="2.5" height="11.5" fill="currentColor" />
          </svg>
          Usage
        </div>
        <div className="flex h-[34px] items-center gap-[10px] rounded-control px-[10px] text-ui text-rail-fg-muted">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="2.25" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.6 2.2" />
          </svg>
          Settings
        </div>
      </nav>

      <div className="flex-1" />

      <div
        aria-hidden
        className="mb-[14px] h-px"
        style={{
          backgroundImage:
            'linear-gradient(to right, transparent, var(--rail-border) 20px, var(--rail-border) calc(100% - 20px), transparent)',
        }}
      />

      <div className="flex flex-col gap-rc-3xs px-[10px] pb-rc-2xs">
        <span className="text-label uppercase tracking-label text-rail-fg-muted">Credits used</span>
        <span className="text-body font-medium text-rail-fg">
          $4.20 <span className="text-meta font-normal text-rail-fg-muted">this month</span>
        </span>
      </div>
    </aside>
  )
}
