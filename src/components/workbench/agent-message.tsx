export type AgentMessageKind = 'assistant' | 'user' | 'tool_run' | 'success' | 'error' | 'working'

export type AgentMessage = {
  id: string
  kind: AgentMessageKind
  content: string
  createdAt: string
}

function RuleRow({
  dotClassName,
  children,
  pulse = false,
}: {
  dotClassName: string
  children: React.ReactNode
  pulse?: boolean
}) {
  return (
    <div className="flex items-center gap-rc-xs border-l border-border-strong py-[3px] pl-[10px]">
      <span
        className={`h-[5px] w-[5px] flex-none rounded-full ${dotClassName}`}
        style={pulse ? { animation: 'rc-pulse 1.3s ease-in-out infinite' } : undefined}
      />
      {children}
    </div>
  )
}

export function AgentMessageItem({ message }: { message: AgentMessage }) {
  switch (message.kind) {
    case 'assistant':
      return (
        <div className="rounded-control bg-accent-wash p-[10px_12px] text-control leading-[1.5]">
          {message.content}
        </div>
      )
    case 'user':
      return (
        <div className="max-w-[84%] self-end rounded-control bg-bg-inset p-[9px_12px] text-control leading-[1.5]">
          {message.content}
        </div>
      )
    case 'tool_run':
      return (
        <RuleRow dotClassName="bg-status-active-fg">
          <span className="flex-1 text-small text-text-secondary">{message.content}</span>
        </RuleRow>
      )
    case 'success':
      return (
        <RuleRow dotClassName="bg-status-done-fg">
          <span className="text-small text-text-secondary">{message.content}</span>
        </RuleRow>
      )
    case 'error':
      return (
        <RuleRow dotClassName="bg-status-failed-fg">
          <span className="flex-1 text-small text-status-failed-fg">{message.content}</span>
          <span className="cursor-pointer text-meta font-medium text-accent hover:underline">Retry</span>
        </RuleRow>
      )
    case 'working':
      return (
        <RuleRow dotClassName="bg-accent" pulse>
          <span className="flex-1 text-small text-text-secondary">{message.content}</span>
          <span className="cursor-pointer text-meta text-text-tertiary hover:text-text-primary">Stop</span>
        </RuleRow>
      )
  }
}
