import type { AspectRatio } from '@/lib/config/enums'
import { PLATE_SIZE } from './plate-size'

function Bar({ className }: { className: string }) {
  return <span className={`block rounded-[3px] bg-bg-inset ${className}`} />
}

// The card's own geometry - plate, title row, button, prompt box, two reference tiles -
// so nothing shifts when a real card resolves (canvas 14B). Server-renderable.
export function PromptCardSkeleton({
  aspectRatio = '9:16',
  badge,
  line2,
  line3,
}: {
  aspectRatio?: AspectRatio
  badge: number
  line2: number
  line3: number
}) {
  const plate = PLATE_SIZE[aspectRatio]
  return (
    <div
      aria-hidden
      className="grid flex-none grid-cols-[auto_1fr] gap-rc-sm rounded-frame border border-border-subtle bg-bg-canvas p-[14px_16px]"
    >
      <div className="rounded-control bg-bg-inset" style={{ width: plate.w, height: plate.h }} />
      <div className="flex min-w-0 flex-col gap-[10px] pt-[2px]">
        <div className="flex items-center gap-[10px]">
          <Bar className="h-[11px] w-[54px]" />
          <span className="block h-[11px] rounded-[3px] bg-bg-inset" style={{ width: badge }} />
          <span className="flex-1" />
          <span className="block h-[30px] w-[104px] rounded-control bg-bg-inset" />
        </div>
        <Bar className="h-[9px] w-[170px]" />
        <div className="flex h-16 flex-col gap-2 rounded-control border border-border-subtle bg-bg-surface p-[11px_12px]">
          <Bar className="h-2 w-full" />
          <span className="block h-2 rounded-[3px] bg-bg-inset" style={{ width: `${line2}%` }} />
          <span className="block h-2 rounded-[3px] bg-bg-inset" style={{ width: `${line3}%` }} />
        </div>
        <div className="flex items-center gap-2">
          <span className="block h-11 w-11 rounded-control bg-bg-inset" />
          <span className="block h-11 w-11 rounded-control bg-bg-inset" />
        </div>
      </div>
    </div>
  )
}
