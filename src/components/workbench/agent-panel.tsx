import { AgentMessageItem, type AgentMessage } from './agent-message'

export function AgentPanel({ messages }: { messages: AgentMessage[] }) {
  return (
    <aside className="flex w-[330px] min-w-[280px] flex-none flex-col border-r border-border-subtle">
      <div className="flex-none border-b border-border-subtle px-rc-md pb-rc-sm pt-rc-md">
        <div className="text-section font-medium tracking-micro text-text-primary">Agent</div>
        <div className="mt-[2px] text-meta text-text-tertiary">Ask for changes, and watch what runs</div>
      </div>

      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col justify-center gap-rc-xs px-rc-md">
          <span className="text-control font-medium text-text-primary">Nothing has run yet</span>
          <span className="text-small leading-[1.5] text-text-secondary">
            Every change the agent makes shows up here, with what it cost.
          </span>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-rc-xs overflow-y-auto px-rc-md py-rc-sm">
          {messages.map((message) => (
            <AgentMessageItem key={message.id} message={message} />
          ))}
        </div>
      )}

      <div className="flex-none border-t border-border-subtle px-rc-md py-rc-sm">
        <input
          disabled
          placeholder="Ask for a change…"
          className="h-[38px] w-full rounded-control border border-border-strong bg-bg-canvas px-3 text-control text-text-tertiary outline-none disabled:cursor-not-allowed"
        />
      </div>
    </aside>
  )
}
