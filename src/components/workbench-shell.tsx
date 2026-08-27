import type { ReactNode } from 'react'
import { WorkbenchStepIndicator } from '@/app/(app)/projects/[id]/workbench/_components/workbench-step-indicator'
import { AgentPanel } from '@/components/workbench/agent-panel'
import type { AgentMessage } from '@/components/workbench/agent-message'

export function WorkbenchShell({
  project,
  agentMessages,
  header,
  footer,
  children,
}: {
  project: { id: string; current_step: string }
  agentMessages: AgentMessage[]
  header: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <div className="flex-none border-b border-border-subtle px-rc-md py-rc-md">{header}</div>
      <WorkbenchStepIndicator projectId={project.id} currentStep={project.current_step} />
      <div className="flex min-h-0 flex-1">
        <AgentPanel messages={agentMessages} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
      {footer && (
        <div className="flex h-16 flex-none items-center justify-between gap-rc-lg border-t border-border-subtle bg-bg-surface px-rc-md">
          {footer}
        </div>
      )}
    </>
  )
}
