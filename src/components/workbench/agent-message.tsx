// Seven message kinds (canvas: "11 Agent panel · taxonomy") - `streaming` is a state of
// `agent`, not its own kind. tool_done/refusal persist to `messages` (kind/shot_key/
// tool_name columns) and reconstruct on reload with a shot number resolved fresh at read
// time, never a stale one baked in at write time - see build-agent-messages.ts. cost is
// never a `messages` row - it's always re-derived from `usage` (live: the `settled` SSE
// event; reload: summed per turn) and only ever rendered when > 0. Only `tool_running`
// and `error` (as a live-turn notification) stay live-only.
export type AgentMessageKind = 'user' | 'agent' | 'tool_done' | 'tool_running' | 'cost' | 'refusal' | 'error'

export type AgentMessage = {
  id: string
  kind: AgentMessageKind
  content: string
  createdAt: string
  // agent only - a 6px accent caret pulses at the tail while true.
  streaming?: boolean
  // cost only - already formatted ("$0.42"); the label above it is `content`, when set.
  amount?: string
  onRetry?: () => void
  onStop?: () => void
  // error only, server-seeded (reload) rows only: the abandoned-turn's original content/
  // client_id, since a server component can't hand this component a working onRetry
  // closure - agent-panel.tsx turns these into a real onRetry client-side on mount.
  retryContent?: string
  retryClientId?: string
}

function RuleRow({
  dotClassName,
  ruleClassName = 'border-border-strong',
  dataMessageKind,
  children,
  pulse = false,
}: {
  dotClassName: string
  ruleClassName?: string
  dataMessageKind: string
  children: React.ReactNode
  pulse?: boolean
}) {
  return (
    <div data-message-kind={dataMessageKind} className={`flex items-center gap-rc-xs border-l py-[3px] pl-[10px] ${ruleClassName}`}>
      <span
        className={`h-[5px] w-[5px] flex-none rounded-full ${dotClassName}`}
        style={pulse ? { animation: 'rc-pulse 1.3s ease-in-out infinite' } : undefined}
      />
      {children}
    </div>
  )
}

function CircleSlashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-none">
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.4 10.6 10.6 3.4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function AgentMessageItem({ message }: { message: AgentMessage }) {
  switch (message.kind) {
    case 'agent':
      return (
        <div
          data-message-kind="agent"
          className="rounded-control bg-accent-wash p-[10px_12px] text-control leading-[1.5]"
        >
          {message.content}
          {message.streaming && (
            <span
              aria-hidden
              className="ml-[3px] inline-block h-[14px] w-[6px] translate-y-[2px] bg-accent"
              style={{ animation: 'rc-pulse 1s ease-in-out infinite' }}
            />
          )}
        </div>
      )
    case 'user':
      return (
        <div
          data-message-kind="user"
          className="max-w-[84%] self-end rounded-control bg-bg-inset p-[9px_12px] text-control leading-[1.5]"
        >
          {message.content}
        </div>
      )
    case 'tool_done':
      return (
        <RuleRow dotClassName="bg-status-done-fg" dataMessageKind="tool_done">
          <span className="text-small text-text-secondary">{message.content}</span>
        </RuleRow>
      )
    case 'tool_running':
      return (
        <RuleRow dotClassName="bg-accent" pulse dataMessageKind="tool_running">
          <span className="flex-1 text-small text-text-secondary">{message.content}</span>
          <button
            type="button"
            onClick={message.onStop}
            className="cursor-pointer text-meta text-text-tertiary hover:text-text-primary"
          >
            Stop
          </button>
        </RuleRow>
      )
    case 'cost':
      return (
        <div data-message-kind="cost" className="flex flex-col gap-[6px] border-l-2 border-accent-faint py-[2px] pl-[9px]">
          {message.content && <span className="text-small text-text-secondary">{message.content}</span>}
          <span className="flex items-baseline justify-between gap-rc-sm rounded-badge bg-bg-inset px-[10px] py-[7px]">
            <span className="text-meta text-text-tertiary">Cost of this turn</span>
            <span className="flex-none font-mono text-small font-medium text-text-primary">{message.amount}</span>
          </span>
        </div>
      )
    case 'refusal':
      return (
        <div
          data-message-kind="refusal"
          className="flex gap-[9px] rounded-control border border-border-muted bg-bg-inset p-[9px_12px]"
        >
          <span className="flex-none pt-[2px] text-text-tertiary">
            <CircleSlashIcon />
          </span>
          <span className="text-control leading-[1.5] text-text-secondary">{message.content}</span>
        </div>
      )
    case 'error':
      return (
        <RuleRow dotClassName="bg-status-failed-fg" ruleClassName="border-status-failed-line" dataMessageKind="error">
          <span className="flex-1 text-small text-status-failed-fg">{message.content}</span>
          <button
            type="button"
            onClick={message.onRetry}
            className="cursor-pointer text-meta font-medium text-accent hover:underline"
          >
            Retry
          </button>
        </RuleRow>
      )
  }
}
