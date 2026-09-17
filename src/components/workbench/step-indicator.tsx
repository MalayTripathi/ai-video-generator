'use client'

import { useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { STEPS as PIPELINE_STEPS, type Step } from '@/lib/config/pipeline'

// Order and membership come from pipeline.ts - the one place the step list
// lives - with `intake` prepended, since it is the pre-project screen and so
// is not a member of Step. Labels stay here because the indicator's sentence
// case is its own display concern; the Record type makes a missing one a
// compile error the next time STEPS changes.
const STEP_LABELS: Record<'intake' | Step, string> = {
  intake: 'Intake',
  workbench: 'Workbench',
  image_prompts: 'Image prompts',
  storyboard: 'Storyboard',
  video_prompts: 'Video prompts',
  generation: 'Generation',
  assembly: 'Assembly',
}

const STEPS: { key: string; label: string }[] = (['intake', ...PIPELINE_STEPS] as const).map(
  (key) => ({ key, label: STEP_LABELS[key] })
)

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-badge border text-chip ${className}`}
    >
      {children}
    </span>
  )
}

// The step row scrolls horizontally (overflow-x-auto), which per the CSS
// spec forces overflow-y to compute as auto too - anything popping outside
// the row vertically (like this tooltip) would get clipped by that box.
// Rendered via a portal + fixed position anchored to the trigger's own
// bounding rect so it always escapes cleanly, regardless of scroll state.
function LockedStep({ index, label, unlockLabel }: { index: number; label: string; unlockLabel?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null)

  function show() {
    const rect = ref.current?.getBoundingClientRect()
    if (rect) setTooltipPos({ top: rect.bottom + 8, left: rect.left + rect.width / 2 })
  }

  function hide() {
    setTooltipPos(null)
  }

  return (
    <span
      ref={ref}
      tabIndex={0}
      aria-disabled="true"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="flex flex-none cursor-not-allowed items-center gap-[9px] outline-none"
    >
      <Badge className="border-border-muted text-text-quiet">{index + 1}</Badge>
      <span className="whitespace-nowrap text-label uppercase tracking-label text-text-quiet">{label}</span>
      {tooltipPos &&
        unlockLabel &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 -translate-x-1/2 whitespace-nowrap rounded-badge bg-text-primary px-[10px] py-[7px] text-meta normal-case tracking-normal text-bg-surface shadow-card-hover"
            style={{ top: tooltipPos.top, left: tooltipPos.left }}
          >
            Complete {unlockLabel} to unlock
            <span
              aria-hidden
              className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-text-primary"
            />
          </div>,
          document.body
        )}
    </span>
  )
}

export function WorkbenchStepIndicator({
  projectId,
  furthestStep,
}: {
  projectId: string
  furthestStep: number
}) {
  // Route-derived, not current_step-derived: current_step is a DB value that only
  // changes on an explicit advanceStep() write, so Back/Forward navigation (which
  // changes the route with no DB write) would otherwise disagree with the page the
  // user is actually looking at. See rail.tsx for the same usePathname() pattern.
  const pathname = usePathname()
  const currentIndex = STEPS.findIndex(
    (step) => step.key !== 'intake' && pathname === `/projects/${projectId}/${step.key}`
  )
  // furthestStep is on pipeline.ts's stepIndex() scale, where intake conceptually
  // occupies slot 1 without being a STEPS member (stepIndex('workbench') === 2) - this
  // component's own STEPS array is 0-based with intake at index 0, so -1 lines the two
  // scales up.
  const furthestIndex = furthestStep - 1

  return (
    <div className="flex h-[50px] flex-none items-stretch gap-rc-sm overflow-x-auto border-b border-border-subtle px-rc-md">
      {STEPS.map((step, index) => {
        const state = index === currentIndex ? 'current' : index <= furthestIndex ? 'complete' : 'locked'

        if (state === 'complete') {
          const content = (
            <>
              <Badge className="border-status-done-fg text-status-done-fg group-hover:border-accent group-hover:text-accent">
                {index + 1}
              </Badge>
              <span className="whitespace-nowrap text-label uppercase tracking-label text-status-done-fg group-hover:font-medium group-hover:text-accent">
                {step.label}
              </span>
            </>
          )

          // /projects/new is the pre-project intake screen, not this
          // project's step 1 - there is no per-project intake route to
          // link to, so it renders inert even though it's complete.
          if (step.key === 'intake') {
            return (
              <div key={step.key} className="relative flex flex-1 items-center justify-center gap-[9px]">
                {content}
                <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-[1px] bg-border-strong" aria-hidden />
              </div>
            )
          }

          return (
            <Link
              key={step.key}
              href={`/projects/${projectId}/${step.key}`}
              className="group relative flex flex-1 items-center justify-center gap-[9px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {content}
              <span
                className="absolute inset-x-0 bottom-0 h-[2px] rounded-[1px] bg-border-strong group-hover:bg-accent"
                aria-hidden
              />
            </Link>
          )
        }

        if (state === 'current') {
          return (
            <div key={step.key} className="relative flex flex-1 items-center justify-center gap-[9px]">
              <Badge className="border-accent font-medium text-accent">{index + 1}</Badge>
              <span className="whitespace-nowrap text-label font-medium uppercase tracking-label text-accent">
                {step.label}
              </span>
              <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-[1px] bg-accent" aria-hidden />
            </div>
          )
        }

        return (
          <div key={step.key} className="relative flex flex-1 items-center justify-center">
            <LockedStep index={index} label={step.label} unlockLabel={STEPS[furthestIndex]?.label} />
            <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-[1px] bg-border-strong" aria-hidden />
          </div>
        )
      })}
    </div>
  )
}
