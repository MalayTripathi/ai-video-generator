import { test, expect } from '@playwright/test'
import { derivePhase } from '../src/app/(app)/projects/[id]/workbench/_components/derive-phase'

test.describe('derivePhase', () => {
  test('pending -> trigger', () => {
    expect(derivePhase({ shotsGeneration: 'pending', shotCount: 0 })).toBe('trigger')
  })

  test('generating -> generating', () => {
    expect(derivePhase({ shotsGeneration: 'generating', shotCount: 0 })).toBe('generating')
  })

  test('ready with zero shots -> failed, never trigger', () => {
    const phase = derivePhase({ shotsGeneration: 'ready', shotCount: 0 })
    expect(phase).toBe('failed')
    expect(phase).not.toBe('trigger')
  })

  test('ready with shots -> list', () => {
    expect(derivePhase({ shotsGeneration: 'ready', shotCount: 3 })).toBe('list')
  })

  test('failed with zero shots -> failed', () => {
    expect(derivePhase({ shotsGeneration: 'failed', shotCount: 0 })).toBe('failed')
  })

  test('failed with shots -> partial', () => {
    expect(derivePhase({ shotsGeneration: 'failed', shotCount: 2 })).toBe('partial')
  })
})
