'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export type SelectOption = { value: string; label: string }

const TYPEAHEAD_RESET_MS = 1000
// Above this many options the menu caps its height and scrolls (canvas: "Open · the
// menu" close-up) - below it every option fits with room to spare, so no scroll/fade.
const SCROLL_THRESHOLD = 8

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="6"
      viewBox="0 0 9 6"
      fill="none"
      aria-hidden="true"
      className={`flex-none text-text-tertiary transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="M1 1.25 4.5 4.75 8 1.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="11" height="8" viewBox="0 0 11 8" fill="none" aria-hidden="true" className="flex-none text-accent">
      <path d="M1 4.2 3.8 7 10 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A from-scratch WAI-ARIA "select-only combobox" (role="combobox" trigger button +
// role="listbox" popup, aria-activedescendant tracks the active option - DOM focus never
// leaves the trigger button, matching "Esc... returns focus to the trigger"). Built from
// scratch because a native <select>'s open popup cannot be restyled by CSS at all - the
// exact limitation this component exists to route around (canvas: "10 - the select
// control"). No headless UI/accessible-primitive package exists in this repo (checked
// package.json: no @radix-ui/*, @headlessui/*, downshift, react-aria, cmdk).
//
// This component owns only the interactive/keyboard/menu mechanics. Callers stay in
// full control of the trigger's visual states (origin borders/badges for the camera
// fields, etc.) via triggerClassName/trailing/renderTriggerContent - matching how the
// native <select> it replaces was already wrapped in a caller-styled container.
export function CustomSelect({
  ariaLabel,
  options,
  value,
  onCommit,
  disabled = false,
  placeholder = 'Select…',
  triggerClassName = '',
  valueClassName = '',
  trailing,
}: {
  ariaLabel: string
  options: SelectOption[]
  value: string | null
  onCommit: (value: string) => void
  disabled?: boolean
  placeholder?: string
  triggerClassName?: string
  valueClassName?: string
  trailing?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [openUpward, setOpenUpward] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLLIElement | null>>([])
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const baseId = useId()

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  useEffect(() => {
    return () => {
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current)
    }
  }, [])

  // Opens the menu: lands the active option on the current value, and picks up/down
  // based on the trigger's own viewport position (available synchronously, no need to
  // wait for the menu itself to render) so it never runs off the pane's bottom edge.
  // Computed here, in the event handlers that open the menu, rather than in an effect
  // reacting to `open` - setState belongs in the handler that knows it just changed,
  // not in an effect synchronizing after the fact.
  function openMenu() {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom
      setOpenUpward(spaceBelow < 280 && rect.top > 280)
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  // Click-out closes without commit - same as Escape.
  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  // Always calls onCommit on an explicit choice, even when the picked value equals the
  // current one - whether that's a real no-op is caller-specific (e.g. a camera field
  // still needs to fire when origin isn't yet 'override', even if the string value is
  // unchanged), so the dedup decision is left to each caller, same as the native
  // <select> handlers this replaces already did.
  function commit(index: number) {
    const option = options[index]
    setOpen(false)
    triggerRef.current?.focus()
    if (option) onCommit(option.value)
  }

  // Closed-trigger arrow/typeahead behaviour steps and commits the value directly,
  // native-<select>-like - it never opens the menu.
  function stepClosed(direction: 1 | -1) {
    if (options.length === 0) return
    const from = selectedIndex >= 0 ? selectedIndex : direction > 0 ? -1 : options.length
    const next = from + direction
    if (next < 0 || next >= options.length) return
    onCommit(options[next].value)
  }

  function matchTypeahead(char: string): number {
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current)
    typeaheadRef.current += char.toLowerCase()
    const buffer = typeaheadRef.current
    typeaheadTimerRef.current = setTimeout(() => {
      typeaheadRef.current = ''
    }, TYPEAHEAD_RESET_MS)
    return options.findIndex((o) => o.label.toLowerCase().startsWith(buffer))
  }

  function isTypeaheadKey(key: string) {
    return key.length === 1 && /[a-z0-9]/i.test(key)
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return

    if (!open) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        openMenu()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        stepClosed(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        stepClosed(-1)
      } else if (isTypeaheadKey(event.key)) {
        const match = matchTypeahead(event.key)
        if (match >= 0) onCommit(options[match].value)
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, options.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        break
      case 'Tab':
        // Never commits - closes with the previous value and moves on.
        setOpen(false)
        break
      default:
        if (isTypeaheadKey(event.key)) {
          const match = matchTypeahead(event.key)
          if (match >= 0) setActiveIndex(match)
        }
    }
  }

  const activeId = open && activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined
  const showScrollFade = options.length > SCROLL_THRESHOLD

  return (
    // w-full is load-bearing, not decorative: without it this div (a flex item with no
    // flex-grow) shrinks to its own content width instead of filling its caller's
    // container, and the menu below - positioned against this same element via
    // left-0/right-0 - inherits that same narrow, content-dependent width. Canvas
    // section 10 states the menu is "trigger width"; this is what makes that true
    // regardless of the selected label's length or whether the menu is open.
    <div ref={rootRef} className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={`${baseId}-listbox`}
        aria-activedescendant={activeId}
        data-value={value ?? ''}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        className={`flex w-full cursor-pointer items-center gap-rc-xs text-left outline-none disabled:cursor-not-allowed ${triggerClassName}`}
      >
        <span className={`min-w-0 flex-1 truncate ${valueClassName}`}>{selected ? selected.label : placeholder}</span>
        {trailing}
        <Chevron open={open} />
      </button>

      {open && (
        <div className={`absolute left-0 right-0 z-30 ${openUpward ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]'}`}>
          <div className="relative overflow-hidden rounded-control border border-border-strong bg-bg-surface p-1 shadow-card-hover">
            <ul
              role="listbox"
              id={`${baseId}-listbox`}
              aria-label={ariaLabel}
              className="flex max-h-[260px] flex-col overflow-y-auto"
            >
              {options.map((option, index) => {
                const isSelected = option.value === value
                const isActive = index === activeIndex
                return (
                  <li
                    key={option.value}
                    id={`${baseId}-option-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    ref={(el) => {
                      optionRefs.current[index] = el
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(index)}
                    className={`flex h-[30px] flex-none cursor-pointer items-center gap-rc-xs rounded-badge px-2 text-control ${
                      isSelected ? 'bg-accent-wash font-medium' : isActive ? 'bg-bg-inset' : ''
                    }`}
                  >
                    <span className="w-[11px] flex-none">{isSelected && <CheckIcon />}</span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  </li>
                )
              })}
            </ul>
            {showScrollFade && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-[1px] bottom-[1px] h-[34px] rounded-b-[7px] bg-gradient-to-b from-transparent to-bg-surface"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
