import { test, expect } from '@playwright/test'
import { derivePhase } from '../src/app/(app)/projects/[id]/workbench/_components/derive-phase'

test.describe('derivePhase', () => {
  test('no generation row -> trigger', () => {
    expect(derivePhase({ generation: null, shotCount: 0 })).toBe('trigger')
  })

  test('no generation row with shots present -> trigger, never list', () => {
    // Mirrors the old null/absent-status fallback: a missing row is treated exactly
    // like 'pending', ignoring shotCount entirely.
    const phase = derivePhase({ generation: null, shotCount: 3 })
    expect(phase).toBe('trigger')
  })

  test('pending -> trigger', () => {
    expect(derivePhase({ generation: { state: 'pending' }, shotCount: 0 })).toBe('trigger')
  })

  test('generating -> generating', () => {
    expect(derivePhase({ generation: { state: 'generating' }, shotCount: 0 })).toBe('generating')
  })

  test('succeeded with zero shots -> failed, never trigger', () => {
    const phase = derivePhase({ generation: { state: 'succeeded' }, shotCount: 0 })
    expect(phase).toBe('failed')
    expect(phase).not.toBe('trigger')
  })

  test('succeeded with shots -> list', () => {
    expect(derivePhase({ generation: { state: 'succeeded' }, shotCount: 3 })).toBe('list')
  })

  test('failed with zero shots -> failed', () => {
    expect(derivePhase({ generation: { state: 'failed' }, shotCount: 0 })).toBe('failed')
  })

  test('failed with shots -> partial', () => {
    expect(derivePhase({ generation: { state: 'failed' }, shotCount: 2 })).toBe('partial')
  })
})
