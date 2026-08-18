'use client'

import { useState } from 'react'
import type { Message } from '../../types'

function SendIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="none" aria-hidden="true">
      <path d="M1 5.5h10M7.75 1.75 11.5 5.5 7.75 9.25" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function Spinner() {
  return (
    <span
      className="block h-[13px] w-[13px] animate-spin rounded-full border-[1.5px] border-accent-faint border-t-accent"
      aria-hidden
    />
  )
}

function WritingIndicator() {
  return (
    <div className="flex items-center gap-rc-2xs py-[2px]">
      <span className="h-[5px] w-[5px] animate-pulse rounded-full bg-text-tertiary" />
      <span className="h-[5px] w-[5px] animate-pulse rounded-full bg-text-tertiary [animation-delay:150ms]" />
      <span className="h-[5px] w-[5px] animate-pulse rounded-full bg-text-tertiary [animation-delay:300ms]" />
      <span className="ml-rc-xs text-small text-text-tertiary">Writing scenes…</span>
    </div>
  )
}

export function ChatPanel({
  messages,
  pending,
  onSend,
}: {
  messages: Message[]
  pending: boolean
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')

  function handleSend() {
    const trimmed = text.trim()
    if (!trimmed || pending) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="flex min-h-0 flex-col border-r border-border-subtle">
      <div className="px-rc-lg pt-[20px] text-section font-medium tracking-micro text-text-primary lg:px-rc-xl xl:px-rc-2xl">
        Refine with Claude
      </div>

      <div className="flex flex-1 flex-col gap-rc-lg overflow-y-auto px-rc-lg py-rc-lg lg:px-rc-xl xl:px-rc-2xl">
        {messages.length === 0 ? (
          <p className="text-control text-text-tertiary">
            Describe the video you want to make, and Claude will draft a script.
          </p>
        ) : (
          messages.map((message) =>
            message.role === 'user' ? (
              <div
                key={message.id}
                className="max-w-[82%] self-end rounded-control bg-bg-inset px-[13px] py-[10px] text-control leading-[1.55] text-text-primary"
              >
                {message.content}
              </div>
            ) : (
              <div key={message.id} className="max-w-[88%] text-control leading-[1.6] text-text-primary">
                {message.content}
              </div>
            )
          )
        )}
        {pending && <WritingIndicator />}
      </div>

      <div className="flex flex-none gap-rc-xs px-rc-lg pb-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend()
          }}
          disabled={pending}
          placeholder="Ask for a change…"
          className="h-10 flex-1 rounded-control border border-border-strong bg-bg-surface px-[13px] text-control text-text-primary outline-none placeholder:text-text-tertiary focus-visible:shadow-[var(--focus-halo)] disabled:opacity-45"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={pending || !text.trim()}
          className="flex h-10 w-10 flex-none items-center justify-center rounded-control border border-accent text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active disabled:opacity-45"
        >
          {pending ? <Spinner /> : <SendIcon />}
        </button>
      </div>
    </div>
  )
}
