import type { Readiness } from '@/lib/storyboard/timeline'
import { lockedReason } from '@/lib/storyboard/timeline'

function LockIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true" className="flex-none">
      <rect x="0.75" y="5.75" width="10.5" height="7.5" rx="1.5" className="stroke-text-quiet" strokeWidth="1.3" />
      <path d="M3.25 5.5V4a2.75 2.75 0 0 1 5.5 0v1.5" className="stroke-text-quiet" strokeWidth="1.3" />
    </svg>
  )
}

// Preview & mix keeps its heading and a held space while locked (canvas 15a), so the page
// has the same three blocks at every moment. The reason is read from real readiness.
export function PreviewLocked({ readiness }: { readiness: Readiness }) {
  const reason = lockedReason(readiness)
  return (
    <div data-testid="preview-locked" className="flex flex-none flex-col gap-[12px]">
      <div className="flex items-baseline gap-[12px]">
        <span className="text-screen font-medium tracking-snug text-text-tertiary">Preview &amp; mix</span>
        <span data-testid="preview-locked-reason" className="flex-1 text-meta text-text-tertiary">
          {reason
            ? `Available once every frame is ready — ${reason}.`
            : 'Every frame is ready. Preview & mix is not available yet.'}
        </span>
        <LockIcon />
      </div>
      <div className="h-[96px] rounded-frame border border-dashed border-border-muted bg-bg-well" />
    </div>
  )
}

function ExportChevron() {
  return (
    <svg width="9" height="6" viewBox="0 0 9 6" fill="none" aria-hidden="true">
      <path d="M1 1.25 4.5 4.75 8 1.25" className="stroke-text-tertiary" strokeWidth="1.3" />
    </svg>
  )
}

// static until export - the collapsed settings row
function ExportSettingsRow() {
  return (
    <div className="flex cursor-pointer items-center gap-[12px] rounded-frame border border-border-subtle bg-bg-canvas p-[13px_15px] hover:border-border-strong">
      <ExportChevron />
      <span className="flex-none text-ui font-medium">Export settings</span>
      <span className="flex-1 text-meta text-text-tertiary">
        Alternate motion · Dissolve · Captions off · Streaming loudness
      </span>
      <span className="text-meta text-text-quiet">locked</span>
    </div>
  )
}

// Export keeps its summary line while locked (canvas 15a).
export function ExportLocked({ readiness }: { readiness: Readiness }) {
  const allReady = lockedReason(readiness) === null
  return (
    <div data-testid="export-locked" className="flex flex-none flex-col gap-[12px] opacity-[0.72]">
      <div className="flex items-baseline gap-[12px]">
        <span className="text-screen font-medium tracking-snug text-text-tertiary">Export</span>
        <span className="flex-1 text-meta text-text-tertiary">
          {allReady ? 'Not available yet.' : 'Locked until every frame is ready.'}
        </span>
      </div>
      <ExportSettingsRow />
    </div>
  )
}
