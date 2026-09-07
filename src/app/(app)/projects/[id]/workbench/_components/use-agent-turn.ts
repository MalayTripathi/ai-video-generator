'use client'

import { useCallback, useRef, useState } from 'react'
// Type-only import - erased at compile time, so no server code (this module imports
// @/lib/supabase/server, the Claude gateway, etc.) reaches the client bundle. The same
// pattern tests/agent-turn.spec.ts already uses to import this exact type.
import type { AgentStreamEvent } from '@/app/api/projects/[id]/agent/logic'

export type AgentTurnHandlers = {
  onTurnStarted?: () => void
  onTextDelta: (text: string) => void
  onToolCompleted: (label: string, shotKey?: string) => void
  onRefusal: (label: string, shotKey?: string) => void
  onError: (message: string) => void
  // Always fires exactly once per send() call, whether the turn settled normally, the
  // server sent an error, or the connection dropped mid-stream - callers rely on this to
  // always re-enable the composer and release any card locks. `content` is the
  // server's own settled text when `dropped` is false; when `dropped` is true, the
  // stream ended (or threw) before a real `settled` event ever arrived and `content` is
  // a synthesized explanation instead.
  onSettled: (content: string, dropped: boolean) => void
}

const DROPPED_STREAM_MESSAGE = "The connection dropped before this finished. Nothing further was changed - try again."

// No EventSource here: this is a POST with a JSON body, which EventSource can't send.
// Reads the response body directly and parses the `event:`/`data:`/`\n\n` SSE framing by
// hand. Not an EventSource polyfill - only the one shape this route actually emits.
export function useAgentTurn(projectId: string) {
  const [isRunning, setIsRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const send = useCallback(
    async (content: string, clientId: string, handlers: AgentTurnHandlers) => {
      setIsRunning(true)
      const controller = new AbortController()
      abortRef.current = controller
      let sawSettled = false

      try {
        const response = await fetch(`/api/projects/${projectId}/agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, clientId }),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          throw new Error(`Request failed (${response.status})`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')

            const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
            if (!dataLine) continue
            const event = JSON.parse(dataLine.slice(5).trim()) as AgentStreamEvent

            // Text deltas render as fast as they arrive, deliberately (canvas: "the
            // words are the progress, no skeleton, no typing dots") - never paced. But
            // several *discrete* progress events (a tool call finishing, the turn
            // settling) routinely land in the same network chunk right behind each
            // other, and without a real event-loop turn between them here, React batches
            // them into one commit - a card would lock and unlock in the same paint,
            // and a burst of log lines would flash in at once instead of appearing as a
            // log. A short, real yield (not a microtask - that still lands before the
            // next paint) gives each one its own moment on screen, the same effect
            // multi-second real network latency between tool calls already produces.
            if (event.type !== 'text_delta') {
              await new Promise((resolve) => setTimeout(resolve, 150))
            }

            switch (event.type) {
              case 'turn_started':
                handlers.onTurnStarted?.()
                break
              case 'text_delta':
                handlers.onTextDelta(event.text)
                break
              case 'tool_completed':
                handlers.onToolCompleted(event.label, event.shotKey)
                break
              case 'refusal':
                handlers.onRefusal(event.label, event.shotKey)
                break
              case 'error':
                handlers.onError(event.message)
                break
              case 'settled':
                sawSettled = true
                handlers.onSettled(event.content, false)
                break
            }
          }
        }
      } catch {
        // A throw here (network failure, non-OK response, an aborted Stop) never carries
        // useful server content - the dropped-stream case below covers it uniformly.
      } finally {
        if (!sawSettled) handlers.onSettled(DROPPED_STREAM_MESSAGE, true)
        abortRef.current = null
        setIsRunning(false)
      }
    },
    [projectId]
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { isRunning, send, stop }
}
