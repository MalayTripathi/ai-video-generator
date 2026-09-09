'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { AgentMessageItem, type AgentMessage } from './agent-message'
import { useShots } from '@/app/(app)/projects/[id]/workbench/_components/shots-context'
import { useAgentTurn } from '@/app/(app)/projects/[id]/workbench/_components/use-agent-turn'
import { describeToolActivity } from '@/lib/agent-activity-display'
import { formatCost } from '@/lib/format-cost'

const EXAMPLE_PROMPTS = ['Make shot 3 shorter', 'Add a shot about the artisans', 'Rewrite everything, colder tone']

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

export function AgentPanel({ initialMessages }: { initialMessages: AgentMessage[] }) {
  const router = useRouter()
  const { projectId, readOnly, shots, lockShot, unlockAllShots, markShotsTouched } = useShots()
  const { isRunning, send, stop } = useAgentTurn(projectId)
  // Seeded rows carrying retryContent/retryClientId (an abandoned historical turn) need a
  // real onRetry closure, which a server component can't hand them - wire it up once here.
  // Safe to reference `runTurn` before its own textual definition below: it's a hoisted
  // function declaration, same pattern the live error/dropped-stream retries already use.
  const [messages, setMessages] = useState<AgentMessage[]>(() =>
    initialMessages.map((m) =>
      m.kind === 'error' && m.retryContent && m.retryClientId
        ? { ...m, onRetry: () => runTurn(m.retryContent!, m.retryClientId!) }
        : m
    )
  )
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // Opens (and stays) scrolled to the most recent message, as a chat panel normally does -
  // both on initial mount after `initialMessages` loads from persistence, and while a live
  // turn streams new ones in.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

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
      onToolCompleted: (label, toolName, shotKey) => {
        clearPlaceholder()
        if (shotKey) {
          lockShot(shotKey)
          touchedKeys.push(shotKey)
        }
        // Never the raw label as-is for a shot-scoped tool: it may already be stale if
        // an earlier tool call THIS SAME turn renumbered shots (e.g. an insert_shot
        // before this one) - re-derive from the current shots list, same as reload does.
        const shotNumber = shotKey ? (shots.find((s) => s.shot_key === shotKey)?.order_index ?? null) : null
        const displayNumber = shotNumber === null ? null : shotNumber + 1
        appendMessages([
          {
            id: crypto.randomUUID(),
            kind: 'tool_done',
            content: describeToolActivity(toolName, displayNumber, label),
            createdAt: nowIso(),
          },
        ])
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
      onSettled: (finalContent, dropped, cost) => {
        clearPlaceholder()
        setMessages((prev) => {
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
          // The streaming bubble is found by id, not by list position: tool_completed/
          // refusal/error events routinely land after it and before settle, so it is
          // usually no longer the last message by the time settle fires. `finalContent`
          // is always exactly what streamed into it (no separate structured closing
          // field exists anymore, now that finish is gone) - finalize in place rather
          // than duplicate. When nothing streamed live at all (a lock/duplicate reply,
          // or the stream already finalized elsewhere), append it as a fresh message.
          const streamingIndex = streamingId ? prev.findIndex((m) => m.id === streamingId) : -1
          if (streamingIndex < 0) {
            return [...prev, { id: crypto.randomUUID(), kind: 'agent', content: finalContent, createdAt: nowIso() }]
          }
          const next = [...prev]
          next[streamingIndex] = { ...next[streamingIndex], content: finalContent, streaming: false }
          return next
        })
        // The turn's real, settled spend - never sourced from the model's own prose.
        // Shown once, below this turn's last line, only when there was any (a dropped
        // connection has no confirmed-spent figure, and a zero-spend turn has nothing
        // worth reporting).
        if (cost !== null && cost > 0) {
          appendMessages([{ id: crypto.randomUUID(), kind: 'cost', content: '', amount: formatCost(cost), createdAt: nowIso() }])
        }
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
        <div ref={listRef} className="flex flex-1 flex-col gap-rc-xs overflow-y-auto px-rc-md py-rc-sm">
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
