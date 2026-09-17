import type { ReactNode } from 'react'
import { WorkbenchStepIndicator } from '@/components/workbench/step-indicator'
import { AgentPanel } from '@/components/workbench/agent-panel'
import type { AgentMessage } from '@/components/workbench/agent-message'

export function WorkbenchShell({
  project,
  agentMessages,
  readOnly,
  shots,
  lockShot,
  unlockAllShots,
  markShotsTouched,
  header,
  footer,
  children,
}: {
  project: { id: string; furthest_step: number }
  agentMessages: AgentMessage[]
  readOnly?: boolean
  shots?: { shot_key: string; order_index: number }[]
  lockShot?: (shotKey: string) => void
  unlockAllShots?: () => void
  markShotsTouched?: (shotKeys: string[]) => void
  header: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <div className="flex-none border-b border-border-subtle px-rc-md py-rc-md">{header}</div>
      <WorkbenchStepIndicator projectId={project.id} furthestStep={project.furthest_step} />
      <div className="flex min-h-0 flex-1">
        <AgentPanel
          initialMessages={agentMessages}
          projectId={project.id}
          readOnly={readOnly}
          shots={shots}
          lockShot={lockShot}
          unlockAllShots={unlockAllShots}
          markShotsTouched={markShotsTouched}
        />
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
