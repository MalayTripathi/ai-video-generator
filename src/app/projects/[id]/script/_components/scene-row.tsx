'use client'

import { useRef, useState } from 'react'
import { updateSceneVoiceOver } from '../../actions'
import type { Scene } from '../../types'

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

function Spinner() {
  return (
    <span
      className="block h-3 w-3 flex-none rounded-full border-[1.5px] border-border-muted border-t-accent"
      style={{ animation: 'rc-spin 0.7s linear infinite' }}
      aria-hidden
    />
  )
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'saving') {
    return (
      <span className="flex flex-none items-center gap-[7px] text-meta text-text-tertiary">
        <Spinner />
        Saving…
      </span>
    )
  }

  if (state === 'saved') {
    return <span className="flex-none text-meta text-text-tertiary">Saved</span>
  }

  if (state === 'failed') {
    return (
      <span className="flex flex-none items-center gap-rc-xs text-meta text-status-failed-fg">
        Save Failed
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer font-medium text-accent outline-none hover:underline"
        >
          Retry
        </button>
      </span>
    )
  }

  return null
}

export function SceneRow({
  projectId,
  scene,
  changed,
  onSaved,
}: {
  projectId: string
  scene: Scene
  changed: boolean
  onSaved: (sceneId: string, voiceOver: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(scene.voice_over)
  const [optimisticVoiceOver, setOptimisticVoiceOver] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  function startEditing() {
    if (saveState === 'saving') return
    setValue(optimisticVoiceOver ?? scene.voice_over)
    setEditing(true)
    requestAnimationFrame(() => {
      if (!textareaRef.current) return
      autosize(textareaRef.current)
      textareaRef.current.select()
    })
  }

  async function attemptSave(trimmed: string) {
    setSaveState('saving')
    try {
      await updateSceneVoiceOver(projectId, scene.id, trimmed)
      onSaved(scene.id, trimmed)
      setOptimisticVoiceOver(null)
      setSaveState('saved')
    } catch {
      setSaveState('failed')
    }
  }

  function save() {
    setEditing(false)
    const trimmed = value.trim()
    const current = optimisticVoiceOver ?? scene.voice_over
    if (!trimmed || trimmed === current || saveState === 'saving') return
    setOptimisticVoiceOver(trimmed)
    void attemptSave(trimmed)
  }

  const displayValue = optimisticVoiceOver ?? scene.voice_over

  return (
    <div
      className={`relative flex items-baseline gap-[18px] border-b border-border-hairline px-rc-lg py-rc-md last:border-b-0 ${
        changed ? 'bg-accent-wash' : ''
      }`}
    >
      {changed && (
        <span className="absolute bottom-[18px] left-0 top-[18px] w-[2px] rounded-[1px] bg-accent" />
      )}
      <span
        className={`w-16 flex-none text-label uppercase tracking-label ${changed ? 'text-accent' : 'text-text-tertiary'}`}
      >
        Scene {scene.position}
      </span>

      {editing ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            autosize(e.target)
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              textareaRef.current?.blur()
            } else if (e.key === 'Escape') {
              setValue(displayValue)
              setEditing(false)
            }
          }}
          autoFocus
          rows={1}
          disabled={saveState === 'saving'}
          className="m-0 flex-1 resize-none rounded-control bg-transparent text-control leading-[1.6] text-text-primary outline-none focus-visible:shadow-[var(--focus-halo)] disabled:cursor-not-allowed"
        />
      ) : (
        <button
          type="button"
          onClick={startEditing}
          disabled={saveState === 'saving'}
          className="m-0 flex-1 cursor-pointer rounded-control text-left text-control leading-[1.6] text-text-primary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed"
        >
          {displayValue}
        </button>
      )}

      <SaveIndicator state={saveState} onRetry={() => attemptSave(optimisticVoiceOver ?? value)} />
    </div>
  )
}
