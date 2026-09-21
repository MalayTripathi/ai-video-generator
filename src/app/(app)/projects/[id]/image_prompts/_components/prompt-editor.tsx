'use client'

import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { useFieldSave } from '../../workbench/_components/use-field-save'
import { updateShotImagePrompt } from '../actions'
import { useImagePrompts } from './image-prompts-context'

// Saves on blur, no Save button, no dirty state: same per-field model as the Workbench.
// A no-op edit performs no request. The field is never disabled while saving. Its save
// status lives in the card header (the card owns useFieldSave), so the textarea itself
// carries nothing but the text and can size purely to it.
export const PromptEditor = memo(function PromptEditor({
  shotId,
  value,
  run,
}: {
  shotId: string
  value: string
  run: ReturnType<typeof useFieldSave>['run']
}) {
  const { updateShotLocal } = useImagePrompts()
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The persisted value can change underneath (a regeneration, an agent edit). Take it
  // unless the person is mid-edit; their own blur-save then wins, last-write-wins as
  // anywhere else on this screen.
  const [seenValue, setSeenValue] = useState(value)
  if (seenValue !== value) {
    setSeenValue(value)
    if (!focused) setDraft(value)
  }

  // Grows and shrinks with the text (and with the column's width, which changes how it
  // wraps). Resetting to `auto` first is what lets it shrink; overflow is hidden so a
  // sub-pixel rounding never shows an inner scrollbar.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    function fit() {
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight + 2}px` // + the 1px border top and bottom
    }
    fit()
    let lastWidth = el.offsetWidth
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === lastWidth) return
      lastWidth = el.offsetWidth
      fit()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [draft])

  function handleBlur() {
    setFocused(false)
    if (draft === value) return
    const submitted = draft
    void run(async () => {
      const result = await updateShotImagePrompt(shotId, submitted)
      if (!result.success) return { success: false, error: result.error }
      if (!result.unchanged) updateShotLocal(shotId, { image_prompt: submitted.trim(), image_prompt_edited: true })
      return { success: true, unchanged: result.unchanged }
    })
  }

  return (
    <textarea
      ref={textareaRef}
      aria-label="Image prompt"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      rows={1}
      className="block min-h-[40px] w-full resize-none overflow-hidden rounded-control border border-border-strong bg-bg-surface px-rc-sm py-[9px] text-small leading-[1.5] text-text-secondary outline-none hover:border-border-strong-hover focus-visible:border-accent focus-visible:text-text-primary focus-visible:shadow-focus-halo"
    />
  )
})
