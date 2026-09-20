import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hasPrompt,
  isEdited,
  isStale,
  isUngenerated,
  shouldAutoGenerate,
  describeShotNumbers,
} from '../src/app/(app)/projects/[id]/image_prompts/_components/derive-image-prompts-phase'
import { imagePromptIsValid } from '../src/lib/image-prompt-edit'
import { ELEMENT_TYPE_IDENT_CLASSNAMES, identDotClassName } from '../src/lib/element-type-labels'
import { ELEMENT_TYPES } from '../src/lib/config/enums'

const shot = (image_prompt: string | null, stale = false, edited = false) => ({
  image_prompt,
  image_prompt_stale: stale,
  image_prompt_edited: edited,
})

test.describe('stale / edited reading', () => {
  test('a flag on a shot with no prompt is never stale or edited - it is ungenerated', () => {
    // The flags accumulated before prompts existed, so the flag alone means nothing.
    expect(isStale(shot(null, true))).toBe(false)
    expect(isEdited(shot(null, false, true))).toBe(false)
    expect(isUngenerated(shot(null, true))).toBe(true)
  })

  test('a blank prompt counts as no prompt', () => {
    expect(hasPrompt({ image_prompt: '   ' })).toBe(false)
    expect(isStale(shot('  ', true))).toBe(false)
  })

  test('stale and edited are independent and can both hold', () => {
    const both = shot('a prompt', true, true)
    expect(isStale(both)).toBe(true)
    expect(isEdited(both)).toBe(true)
    expect(isStale(shot('a prompt', false, true))).toBe(false)
    expect(isEdited(shot('a prompt', true, false))).toBe(false)
  })
})

test.describe('shouldAutoGenerate', () => {
  const none = [shot(null), shot(null, true)]

  test('fires once for a never-attempted project with no prompts at all', () => {
    expect(shouldAutoGenerate({ generationState: null, shots: none, readOnly: false })).toBe(true)
    expect(shouldAutoGenerate({ generationState: 'pending', shots: none, readOnly: false })).toBe(true)
  })

  test('never re-fires once any attempt exists, whatever its state', () => {
    for (const state of ['generating', 'succeeded', 'failed']) {
      expect(shouldAutoGenerate({ generationState: state, shots: none, readOnly: false })).toBe(false)
    }
  })

  test('never fires when any shot already has a prompt, or there are no shots, or it is read-only', () => {
    expect(shouldAutoGenerate({ generationState: null, shots: [shot(null), shot('a prompt')], readOnly: false })).toBe(false)
    expect(shouldAutoGenerate({ generationState: null, shots: [], readOnly: false })).toBe(false)
    expect(shouldAutoGenerate({ generationState: null, shots: none, readOnly: true })).toBe(false)
  })
})

test('describeShotNumbers', () => {
  expect(describeShotNumbers([2])).toBe('Shot 2')
  expect(describeShotNumbers([5, 2])).toBe('Shots 2 and 5')
  expect(describeShotNumbers([2, 3, 5])).toBe('Shots 2, 3 and 5')
})

test('a hand-edited prompt only has to be non-blank', () => {
  expect(imagePromptIsValid('x')).toBe(true)
  expect(imagePromptIsValid('   \n ')).toBe(false)
})

test.describe('identity tokens', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'app', 'globals.css'), 'utf8')
  const darkStart = css.indexOf('.dark {')

  test('every element type has ident fg and bg in light, dark, and the Tailwind theme', () => {
    for (const type of ELEMENT_TYPES) {
      for (const part of ['fg', 'bg']) {
        const name = `--ident-${type}-${part}:`
        const first = css.indexOf(name)
        expect(first, `${name} in light`).toBeGreaterThan(-1)
        expect(css.indexOf(name, darkStart), `${name} in dark`).toBeGreaterThan(darkStart)
        expect(css).toContain(`--color-ident-${type}-${part}:`)
      }
    }
  })

  test('the class map covers every element type with classes Tailwind can generate', () => {
    for (const type of ELEMENT_TYPES) {
      expect(ELEMENT_TYPE_IDENT_CLASSNAMES[type].dot).toBe(`bg-ident-${type}-fg`)
      expect(ELEMENT_TYPE_IDENT_CLASSNAMES[type].chip).toBe(`bg-ident-${type}-bg text-ident-${type}-fg`)
    }
  })

  test('the dot helper resolves a known type and falls back to neutral for an unrecognised one', () => {
    expect(identDotClassName('location')).toBe('bg-ident-location-fg')
    expect(identDotClassName('something-else')).toBe('bg-border-strong')
  })

  test('stale and edited state tokens exist in both modes', () => {
    for (const name of ['--status-stale-fg:', '--status-stale-bg:', '--status-stale-line:', '--status-edited-fg:', '--status-edited-bg:', '--status-active-line:']) {
      expect(css.indexOf(name), `${name} light`).toBeGreaterThan(-1)
      expect(css.indexOf(name, darkStart), `${name} dark`).toBeGreaterThan(darkStart)
    }
  })
})
