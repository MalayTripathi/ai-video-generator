import type { WizardStep } from '../types'

const STEPS: { key: WizardStep; label: string }[] = [
  { key: 'script', label: 'Script' },
  { key: 'voiceover', label: 'Voiceover' },
  { key: 'images', label: 'Images' },
  { key: 'video', label: 'Video' },
]

function CheckIcon() {
  return (
    <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
      <path d="M1 4.25 3.5 6.75 9 1.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function StepIndicator({ currentStep }: { currentStep: WizardStep }) {
  const currentIndex = STEPS.findIndex((step) => step.key === currentStep)

  return (
    <div className="flex h-16 flex-none items-center gap-rc-lg border-b border-border-subtle px-rc-lg lg:px-rc-xl xl:px-rc-2xl">
      {STEPS.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming'

        return (
          <div key={step.key} className="flex items-center gap-rc-lg">
            {index > 0 && <span className="block h-px w-[34px] bg-border-muted" aria-hidden />}
            <div className="flex items-center gap-[9px]">
              {state === 'done' ? (
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-badge bg-status-done-bg text-status-done-fg">
                  <CheckIcon />
                </span>
              ) : (
                <span
                  className={
                    state === 'current'
                      ? 'flex h-[22px] w-[22px] items-center justify-center rounded-badge border border-accent text-chip font-medium text-accent'
                      : 'flex h-[22px] w-[22px] items-center justify-center rounded-badge border border-border-muted text-chip text-text-tertiary'
                  }
                >
                  {index + 1}
                </span>
              )}
              <span
                className={
                  state === 'done'
                    ? 'text-control text-status-done-fg'
                    : state === 'current'
                      ? 'text-control font-medium text-accent'
                      : 'text-control text-text-tertiary'
                }
              >
                {step.label}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
