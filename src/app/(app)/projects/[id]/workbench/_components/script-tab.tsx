'use client'

import { useState } from 'react'
import { useShots } from './shots-context'
import { formatDuration } from '@/lib/format-duration'
import { countWords } from '@/lib/word-count'
import type { DisplayShot } from './types'

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="3.4" y="1" width="7.6" height="7.6" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8.6 10.4v0.4a0.8 0.8 0 0 1-0.8 0.8H1.8a0.8 0.8 0 0 1-0.8-0.8V4.2a0.8 0.8 0 0 1 0.8-0.8h0.4"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function ExportIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1.4v6.9M3.2 5.5 6 8.3l2.8-2.8" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M1.2 8.4v1.4a0.8 0.8 0 0 0 0.8 0.8h8a0.8 0.8 0 0 0 0.8-0.8V8.4"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}

// The spoken read only - no "Shot N" labels, no speaker names, no counts. Those are
// on-screen navigation aids for reading along; a user pasting into a teleprompter or a
// document wants only the words that get spoken. A shot with neither narration nor
// dialogue contributes nothing.
function buildScriptText(shots: DisplayShot[]): string {
  const lines: string[] = []
  for (const shot of [...shots].sort((a, b) => a.order_index - b.order_index)) {
    if (shot.voice_over) lines.push(shot.voice_over)
    for (const line of [...shot.dialogue].sort((a, b) => a.order_index - b.order_index)) {
      lines.push(line.line)
    }
  }
  return lines.join('\n\n')
}

function ScriptShotRow({ shot }: { shot: DisplayShot }) {
  const dialogue = [...shot.dialogue].sort((a, b) => a.order_index - b.order_index)
  return (
    <div className="grid grid-cols-[62px_1fr] gap-rc-sm">
      <span className="pt-1 font-mono text-mono text-text-tertiary">Shot {shot.order_index + 1}</span>
      <div className="flex flex-col gap-[6px]">
        {shot.voice_over && <span className="text-body leading-[1.6]">{shot.voice_over}</span>}
        {dialogue.map((line) => (
          <div
            key={line.id}
            className="grid grid-cols-[84px_1fr] gap-rc-xs border-l-2 border-border-strong pl-[10px]"
          >
            <span className="pt-[3px] text-label uppercase tracking-label text-text-tertiary">
              {line.element_name || 'Unbound speaker'}
            </span>
            <span className="text-body leading-[1.6] text-text-secondary">&ldquo;{line.line}&rdquo;</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ScriptTab() {
  const { shots } = useShots()
  const [copied, setCopied] = useState(false)

  const sortedShots = [...shots].sort((a, b) => a.order_index - b.order_index)
  const totalSeconds = shots.reduce((sum, shot) => sum + (shot.duration_sec ?? 0), 0)
  const wordCount =
    shots.reduce((sum, shot) => sum + countWords(shot.voice_over), 0) +
    shots.reduce((sum, shot) => sum + shot.dialogue.reduce((n, line) => n + countWords(line.line), 0), 0)
  const scriptText = buildScriptText(shots)

  async function handleCopy() {
    await navigator.clipboard.writeText(scriptText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleExport() {
    const blob = new Blob([scriptText], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'script.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-rc-sm">
      <div className="flex items-center justify-between gap-rc-md">
        <span className="flex items-center gap-rc-xs">
          <span className="flex items-center gap-[5px] rounded-full bg-bg-inset px-[10px] py-[3px] text-chip text-text-secondary">
            Read-only — Edit in Shots
          </span>
          <span className="font-mono text-meta text-text-tertiary">
            {formatDuration(totalSeconds)} · {wordCount} words
          </span>
        </span>
        <span className="flex flex-none gap-rc-xs">
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-[30px] cursor-pointer items-center gap-[6px] rounded-control border border-border-strong px-[10px] text-small hover:bg-bg-inset hover:border-border-strong-hover"
          >
            <CopyIcon />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="flex h-[30px] cursor-pointer items-center gap-[6px] rounded-control border border-border-strong px-[10px] text-small hover:bg-bg-inset hover:border-border-strong-hover"
          >
            <ExportIcon />
            Export .txt
          </button>
        </span>
      </div>
      <div className="flex flex-col gap-[14px] rounded-control border border-border-subtle bg-bg-inset p-rc-md">
        {sortedShots.map((shot) => (
          <ScriptShotRow key={shot.id} shot={shot} />
        ))}
      </div>
    </div>
  )
}
