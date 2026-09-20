'use client'

import { InsufficientCreditsBanner } from '@/components/insufficient-credits-banner'
import { useImagePrompts } from './image-prompts-context'
import { BatchBar } from './batch-bar'
import { OutcomeBanner } from './outcome-banner'
import { ConfirmModal } from './confirm-modal'
import { PromptCard } from './prompt-card'

export function PromptList() {
  const { shots, outcome } = useImagePrompts()

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-rc-sm overflow-y-auto px-rc-md py-rc-md">
      {outcome?.kind === 'insufficient' && (
        <InsufficientCreditsBanner
          title="Not enough credits to write these prompts"
          subject="This"
          requiredCredits={outcome.required}
          balanceCredits={outcome.balance}
        />
      )}
      <OutcomeBanner />
      <BatchBar />
      {shots.length === 0 ? (
        <div className="rounded-control border border-dashed border-border-strong p-rc-lg text-center text-small text-text-secondary">
          There are no shots to write prompts for.
        </div>
      ) : (
        <div className="flex flex-col gap-[10px]">
          {shots.map((shot) => (
            <PromptCard key={shot.id} shot={shot} />
          ))}
        </div>
      )}
      <ConfirmModal />
    </div>
  )
}
