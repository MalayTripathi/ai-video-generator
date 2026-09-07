'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { AgentMessageItem, type AgentMessage } from './agent-message'
import { useShots } from '@/app/(app)/projects/[id]/workbench/_components/shots-context'
import { useAgentTurn } from '@/app/(app)/projects/[id]/workbench/_components/use-agent-turn'

const EXAMPLE_PROMPTS = ['Make shot 3 shorter', 'Add a shot about the artisans', 'Rewrite everything, colder tone']

// Server-generated cost is embedded in this one tool's label only
// ("Regenerated all shots ($0.42)") since Claude is never told the figure itself (see
// docs/decisions.md). Display-only pattern match, never used for shot identity/locking -
// that's `shotKey`'s job exclusively. Kept isolated here so it doesn't become a precedent
// for parsing `label` for anything else.
const REGENERATE_COST_RE = /^Regenerated all shots(?: \(\$([\d.]+)\))?$/

function LockIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" aria-hidden="true" className="flex-none">
      <rect x="0.75" y="4.9" width="8.5" height="6.35" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.75 4.9V3.3a2.25 2.25 0 0 1 4.5 0v1.6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ animation: 'rc-spin 0.8s linear infinite' }}>
      <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.3" strokeDasharray="8 20" strokeLinecap="round" />
    </svg>
  )
}

function nowIso() {
  return new Date().toISOString()
}

function toToolMessages(label: string, shotKey: string | undefined): AgentMessage[] {
  if (!shotKey) {
    const match = REGENERATE_COST_RE.exec(label)
    if (match && match[1]) {
      return [
        { id: crypto.randomUUID(), kind: 'tool_done', content: 'Regenerated all shots', createdAt: nowIso() },
        {
          id: crypto.randomUUID(),
          kind: 'cost',
          content: 'Regenerated all shots',
          amount: `$${match[1]}`,
          createdAt: nowIso(),
        },
      ]
    }
  }
  return [{ id: crypto.randomUUID(), kind: 'tool_done', content: label, createdAt: nowIso() }]
}

export function AgentPanel({ initialMessages }: { initialMessages: AgentMessage[] }) {
  const router = useRouter()
  const { projectId, readOnly, lockShot, unlockAllShots, markShotsTouched } = useShots()
  const { isRunning, send, stop } = useAgentTurn(projectId)
  const [messages, setMessages] = useState<AgentMessage[]>(initialMessages)
  const [input, setInput] = useState('')

  function appendMessages(next: AgentMessage[]) {
    setMessages((prev) => [...prev, ...next])
  }

  function removeMessage(id: string) {
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }

  function runTurn(content: string, clientId: string) {
    // A fresh display id even on retry (a distinct list entry each time Retry is
    // pressed) - `clientId` is reused for the network request's idempotency, but the
    // two ids serve different purposes and must not be conflated.
    appendMessages([{ id: crypto.randomUUID(), kind: 'user', content, createdAt: nowIso() }])

    const placeholderId = crypto.randomUUID()
    let placeholderCleared = false
    appendMessages([
      { id: placeholderId, kind: 'tool_running', content: 'Agent is working…', createdAt: nowIso(), onStop: stop },
    ])

    let streamingId: string | null = null
    const touchedKeys: string[] = []

    function clearPlaceholder() {
      if (placeholderCleared) return
      placeholderCleared = true
      removeMessage(placeholderId)
    }

    void send(content, clientId, {
      onTextDelta: (text) => {
        clearPlaceholder()
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (streamingId && last?.id === streamingId && last.kind === 'agent') {
            return [...prev.slice(0, -1), { ...last, content: last.content + text }]
          }
          streamingId = crypto.randomUUID()
          return [...prev, { id: streamingId, kind: 'agent', content: text, createdAt: nowIso(), streaming: true }]
        })
      },
      onToolCompleted: (label, shotKey) => {
        clearPlaceholder()
        if (shotKey) {
          lockShot(shotKey)
          touchedKeys.push(shotKey)
        }
        appendMessages(toToolMessages(label, shotKey))
      },
      onRefusal: (label) => {
        clearPlaceholder()
        appendMessages([{ id: crypto.randomUUID(), kind: 'refusal', content: label, createdAt: nowIso() }])
      },
      onError: (message) => {
        clearPlaceholder()
        appendMessages([
          {
            id: crypto.randomUUID(),
            kind: 'error',
            content: message,
            createdAt: nowIso(),
            // Reuses this exact turn's clientId - a retry of the same message, never a
            // new one (see CLAUDE.md / docs/decisions.md on client_id idempotency).
            onRetry: () => runTurn(content, clientId),
          },
        ])
      },
      onSettled: (finalContent, dropped) => {
        clearPlaceholder()
        setMessages((prev) => {
          // The streaming bubble is found by id, not by list position: tool_completed/
          // refusal/error events routinely land after it and before settle, so it is
          // usually no longer the last message by the time settle fires.
          const streamingIndex = !dropped && streamingId ? prev.findIndex((m) => m.id === streamingId) : -1
          if (streamingIndex >= 0) {
            const next = [...prev]
            next[streamingIndex] = { ...next[streamingIndex], content: finalContent, streaming: false }
            return next
          }
          if (dropped) {
            return [
              ...prev,
              {
                id: crypto.randomUUID(),
                kind: 'error',
                content: finalContent,
                createdAt: nowIso(),
                onRetry: () => runTurn(content, clientId),
              },
            ]
          }
          return [...prev, { id: crypto.randomUUID(), kind: 'agent', content: finalContent, createdAt: nowIso() }]
        })
        unlockAllShots()
        if (touchedKeys.length > 0) markShotsTouched(touchedKeys)
        router.refresh()
      },
    })
  }

  function handleSend(content: string) {
    const trimmed = content.trim()
    if (trimmed.length === 0 || isRunning || readOnly) return
    setInput('')
    runTurn(trimmed, crypto.randomUUID())
  }

  return (
    <aside className="flex w-[330px] min-w-[280px] flex-none flex-col border-r border-border-subtle">
      <div className="flex-none border-b border-border-subtle px-rc-md pb-rc-sm pt-rc-md">
        <div className="text-section font-medium tracking-micro text-text-primary">Agent</div>
        <div className="mt-[2px] text-meta text-text-tertiary">Ask for changes, and watch what runs</div>
      </div>

      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col justify-center gap-rc-xs px-rc-md">
          <span className="text-control font-medium text-text-primary">Ask for a change in plain words</span>
          <span className="text-small leading-[1.5] text-text-secondary">Every edit shows up here with what it cost.</span>
          {!readOnly && (
            <div className="mt-rc-2xs flex flex-col gap-[5px]">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="cursor-pointer rounded-control border border-border-subtle px-rc-xs py-[6px] text-left text-meta text-text-secondary hover:border-accent hover:bg-accent-wash hover:text-accent"
                >
                  {example}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-rc-xs overflow-y-auto px-rc-md py-rc-sm">
          {messages.map((message) => (
            <AgentMessageItem key={message.id} message={message} />
          ))}
        </div>
      )}

      <div className="flex-none border-t border-border-subtle px-rc-md py-rc-sm">
        {readOnly ? (
          <div className="flex min-h-[38px] items-center gap-[7px] rounded-control bg-bg-inset px-3 text-small leading-[1.4] text-text-secondary">
            <LockIcon />
            Editing closed at the storyboard step
          </div>
        ) : isRunning ? (
          <div className="flex gap-rc-xs">
            <div className="flex h-[38px] flex-1 cursor-not-allowed items-center gap-[7px] rounded-control border border-border-subtle bg-bg-inset px-3 text-control text-text-secondary">
              <Spinner />
              Agent is working — you can&rsquo;t send until this finishes
            </div>
            <button
              type="button"
              onClick={stop}
              className="h-[38px] flex-none cursor-pointer rounded-control border border-border-strong px-rc-sm text-small hover:bg-bg-inset"
            >
              Stop
            </button>
          </div>
        ) : (
          <div className="flex gap-rc-xs">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSend(input)
              }}
              placeholder="Ask for a change…"
              aria-label="Ask for a change"
              className="h-[38px] flex-1 rounded-control border border-border-strong bg-bg-surface px-3 text-control text-text-primary outline-none placeholder:text-text-tertiary focus-visible:border-accent focus-visible:shadow-focus-halo"
            />
            <button
              type="button"
              disabled={input.trim().length === 0}
              onClick={() => handleSend(input)}
              className="h-[38px] flex-none cursor-pointer rounded-control border border-border-subtle px-rc-sm text-small text-text-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:text-text-quiet disabled:hover:border-border-subtle disabled:hover:text-text-quiet"
            >
              Send
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
