import type { DisplayElement, DisplayShot } from './types'

function elementDotClassName(el: DisplayElement) {
  if (el.reference_image_path) return 'bg-status-done-fg'
  if (el.status === 'generating') return 'bg-status-active-fg'
  if (el.status === 'failed') return 'bg-status-failed-fg'
  return 'bg-border-strong' // pending / no reference - the only state reachable this task
}

export function ShotCard({ shot }: { shot: DisplayShot }) {
  return (
    <div
      data-testid="shot-card"
      className="flex flex-col gap-rc-2xs rounded-control border border-border-subtle bg-bg-surface p-3 px-rc-md shadow-card"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-rc-xs">
          <span className="text-body font-medium tracking-micro text-text-primary">
            Shot {shot.order_index + 1}
          </span>
          {shot.section_label && (
            <span className="rounded-badge bg-bg-inset px-rc-xs py-[3px] text-chip text-text-secondary">
              {shot.section_label}
            </span>
          )}
        </div>
        {shot.duration_sec !== null && (
          <span className="font-mono text-meta text-text-tertiary">{shot.duration_sec}s</span>
        )}
      </div>

      {shot.voice_over && (
        <div className="flex gap-rc-xs pl-px">
          <span className="w-[2px] flex-none rounded-[1px] bg-accent-faint" aria-hidden />
          <span className="pt-[3px] font-mono text-mono text-text-tertiary">vo</span>
          <span className="text-body leading-[1.5] text-text-primary">{shot.voice_over}</span>
        </div>
      )}

      {shot.dialogue.map((line) => (
        <div key={`${line.element_id}-${line.line}`} className="grid grid-cols-[84px_1fr] gap-rc-xs pl-px">
          <span className="pt-[1px] text-label uppercase tracking-label text-text-tertiary">
            {line.element_name}
          </span>
          <span className="text-body leading-[1.5] text-text-secondary">&ldquo;{line.line}&rdquo;</span>
        </div>
      ))}

      {shot.visual_description && (
        <div className="text-small leading-[1.5] text-text-secondary">{shot.visual_description}</div>
      )}

      {shot.elements.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-rc-2xs">
          {shot.elements.map((el) => (
            <span
              key={el.id}
              className="flex items-center gap-[5px] rounded-badge bg-bg-inset px-rc-xs py-[3px] text-chip text-text-secondary"
            >
              <span className={`h-[5px] w-[5px] rounded-full ${elementDotClassName(el)}`} aria-hidden />
              {el.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
