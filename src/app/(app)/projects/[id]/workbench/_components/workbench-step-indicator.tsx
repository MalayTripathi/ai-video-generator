'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'

const STEPS: { key: string; label: string }[] = [
  { key: 'intake', label: 'Intake' },
  { key: 'workbench', label: 'Workbench' },
  { key: 'voiceover', label: 'Voiceover' },
  { key: 'image_prompts', label: 'Image prompts' },
  { key: 'storyboard', label: 'Storyboard' },
  { key: 'video_prompts', label: 'Video prompts' },
  { key: 'generation', label: 'Generation' },
  { key: 'assembly', label: 'Assembly' },
]

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
  currentStep,
}: {
  projectId: string
  currentStep: string
}) {
  const currentIndex = STEPS.findIndex((step) => step.key === currentStep)

  return (
    <div className="flex h-[50px] flex-none items-stretch gap-rc-lg overflow-x-auto border-b border-border-subtle px-rc-md">
      {STEPS.map((step, index) => {
        const state = index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'locked'

        if (state === 'complete') {
          const content = (
            <>
              <Badge className="border-status-done-fg text-status-done-fg">{index + 1}</Badge>
              <span className="whitespace-nowrap text-label uppercase tracking-label text-status-done-fg group-hover:text-text-primary">
                {step.label}
              </span>
            </>
          )

          // /projects/new is the pre-project intake screen, not this
          // project's step 1 - there is no per-project intake route to
          // link to, so it renders inert even though it's complete.
          if (step.key === 'intake') {
            return (
              <div key={step.key} className="flex flex-none items-center gap-[9px]">
                {content}
              </div>
            )
          }

          return (
            <Link
              key={step.key}
              href={`/projects/${projectId}/${step.key}`}
              className="group flex flex-none items-center gap-[9px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {content}
            </Link>
          )
        }

        if (state === 'current') {
          return (
            <div key={step.key} className="relative flex flex-none items-center gap-[9px]">
              <Badge className="border-accent font-medium text-accent">{index + 1}</Badge>
              <span className="whitespace-nowrap text-label font-medium uppercase tracking-label text-accent">
                {step.label}
              </span>
              <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-[1px] bg-accent" aria-hidden />
            </div>
          )
        }

        return (
          <LockedStep key={step.key} index={index} label={step.label} unlockLabel={STEPS[currentIndex]?.label} />
        )
      })}
    </div>
  )
}
