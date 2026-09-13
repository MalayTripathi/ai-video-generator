import { test, expect } from '@playwright/test'
import { STEPS, OPERATIONS } from '../src/lib/config/pipeline'
import {
  usdToCredits,
  creditsFor,
  MissingCreditPriceError,
  PRICE_TABLE,
} from '../src/lib/config/credits'

// Pure-function coverage for src/lib/config/credits.ts - no DB, no network. No
// application code reads this module yet (Task 4's concern); these tests are the
// only consumer besides pipeline.ts's types.

test.describe('usdToCredits', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [0.0001, 1],
    [0.001, 1],
    [0.0011, 2],
    [0.014, 14],
  ]

  for (const [usd, expected] of cases) {
    test(`${usd} usd -> ${expected} credits`, async () => {
      expect(usdToCredits(usd)).toBe(expected)
    })
  }
})

test.describe('creditsFor', () => {
  test('per_shot scales with quantity', async () => {
    const one = creditsFor({ step: 'workbench', operation: 'generate_shots', quantity: 1 })
    const eight = creditsFor({ step: 'workbench', operation: 'generate_shots', quantity: 8 })
    expect(eight).toBe(one * 8)
  })

  test('per_project ignores quantity', async () => {
    const qty1 = creditsFor({ step: 'assembly', operation: 'merge', quantity: 1 })
    const qty99 = creditsFor({ step: 'assembly', operation: 'merge', quantity: 99 })
    expect(qty1).toBe(qty99)
  })

  test('per_element scales with quantity', async () => {
    const one = creditsFor({ step: 'workbench', operation: 'generate_element_reference', quantity: 1 })
    const four = creditsFor({ step: 'workbench', operation: 'generate_element_reference', quantity: 4 })
    expect(four).toBe(one * 4)
  })

  test('throws MissingCreditPriceError for (generation, generate_clip)', async () => {
    expect(() => creditsFor({ step: 'generation', operation: 'generate_clip', quantity: 1 })).toThrow(
      MissingCreditPriceError
    )
  })

  test('throws MissingCreditPriceError for (workbench, agent_turn) - dynamic pricing not reachable here', async () => {
    expect(() => creditsFor({ step: 'workbench', operation: 'agent_turn', quantity: 1 })).toThrow(
      MissingCreditPriceError
    )
  })
})

test.describe('PRICE_TABLE membership', () => {
  test('every keyed (step, operation) pair is a real STEPS/OPERATIONS member', async () => {
    for (const step of Object.keys(PRICE_TABLE) as Array<keyof typeof PRICE_TABLE>) {
      expect(STEPS).toContain(step)
      const operations = PRICE_TABLE[step]!
      for (const operation of Object.keys(operations)) {
        expect(OPERATIONS).toContain(operation)
      }
    }
  })
})
