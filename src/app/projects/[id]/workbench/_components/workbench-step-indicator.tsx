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

function CheckIcon() {
  return (
    <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
      <path d="M1 4.25 3.5 6.75 9 1.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function WorkbenchStepIndicator({ currentStep }: { currentStep: string }) {
  const currentIndex = STEPS.findIndex((step) => step.key === currentStep)

  return (
    <div className="flex h-16 flex-none items-center gap-rc-md overflow-x-auto border-b border-border-subtle px-rc-lg lg:px-rc-xl xl:px-rc-2xl">
      {STEPS.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming'

        return (
          <div key={step.key} className="flex flex-none items-center gap-rc-md">
            {index > 0 && <span className="block h-px w-[22px] bg-border-muted" aria-hidden />}
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
                    ? 'whitespace-nowrap text-control text-status-done-fg'
                    : state === 'current'
                      ? 'whitespace-nowrap text-control font-medium text-accent'
                      : 'whitespace-nowrap text-control text-text-tertiary'
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
