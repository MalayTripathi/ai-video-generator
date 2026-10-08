import type { AspectRatio } from '@/lib/config/enums'
import type { Readiness } from '@/lib/storyboard/timeline'
import { previewBoxStyle } from './preview-mix'
import { lockedReason } from '@/lib/storyboard/timeline'

function LockIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true" className="flex-none">
      <rect x="0.75" y="5.75" width="10.5" height="7.5" rx="1.5" className="stroke-text-quiet" strokeWidth="1.3" />
      <path d="M3.25 5.5V4a2.75 2.75 0 0 1 5.5 0v1.5" className="stroke-text-quiet" strokeWidth="1.3" />
    </svg>
  )
}

// Preview & mix keeps its heading and a held space while locked (canvas 15a/15i), so the
// page has the same three blocks at every moment: the well takes the player's height for
// the project's ratio, so nothing jumps when it unlocks. The reason is read from real readiness.
export function PreviewLocked({ readiness, aspectRatio }: { readiness: Readiness; aspectRatio: AspectRatio }) {
  const reason = lockedReason(readiness)
  const box = previewBoxStyle(aspectRatio)
  return (
    <div data-testid="preview-locked" className="flex flex-none flex-col gap-[12px]">
      <div className="flex items-baseline gap-[12px]">
        <span className="text-screen font-medium tracking-snug text-text-tertiary">Preview &amp; mix</span>
        <span data-testid="preview-locked-reason" className="flex-1 text-meta text-text-tertiary">
          {reason ? `Available once every frame is ready — ${reason}.` : 'Available once every frame is ready.'}
        </span>
        <LockIcon />
      </div>
      <div
        data-testid="preview-locked-well"
        className="rounded-frame border border-dashed border-border-muted bg-bg-well"
        style={{ height: box.height }}
      />
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

// The collapsed settings row while Export is locked (canvas 15a): the summary is the
// project's real settings.
function ExportSettingsRow({ summary }: { summary: string }) {
  return (
    <div className="flex items-center gap-[12px] rounded-frame border border-border-subtle bg-bg-canvas p-[13px_15px]">
      <ExportChevron />
      <span className="flex-none text-ui font-medium">Export settings</span>
      <span data-testid="export-summary" className="flex-1 text-meta text-text-tertiary">
        {summary}
      </span>
      <span className="text-meta text-text-quiet">locked</span>
    </div>
  )
}

// Export keeps its summary line while locked (canvas 15a).
export function ExportLocked({ summary }: { summary: string }) {
  return (
    <div data-testid="export-locked" className="flex flex-none flex-col gap-[12px] opacity-[0.72]">
      <div className="flex items-baseline gap-[12px]">
        <span className="text-screen font-medium tracking-snug text-text-tertiary">Export</span>
        <span className="flex-1 text-meta text-text-tertiary">
          Locked until every frame is ready.
        </span>
      </div>
      <ExportSettingsRow summary={summary} />
    </div>
  )
}
