import { test, expect } from '@playwright/test'
import fixture from './fixtures/agent-turn-calibration.json'
import { computeCost } from '../src/lib/config/pricing'
import {
  AGENT_TURN_ESTIMATE,
  estimateAgentTurnCost,
  estimateExpectedCallCost,
  quoteClaudeCall,
} from '../src/lib/usage/quote'
import { expectedImagePromptsOutputTokens } from '../src/lib/prompts/image-prompts'

// The turn-level balance gate needs a number BEFORE any call is made. The per-call quote
// (quoteClaudeCall) reserves the full 8192-token output ceiling, ~11x what a real agent
// call produces, and is meant for a spend-cap reservation - as a balance gate it refused
// perfectly affordable turns. This estimator is calibrated on real turns instead: an agent
// turn is 1-3 calls (n=17: 3 x one call, 7 x two, 7 x three), each a few hundred output
// tokens, with input that runs ~10-15% above what chars/4 predicts and grows as tool
// results are appended.

const HAIKU = 'claude-haiku-4-5-20251001'
const measured = (input: number, output: number) =>
  computeCost('anthropic', HAIKU, {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }).estimatedCost!

test.describe('estimateAgentTurnCost', () => {
  test('is the sum of maxCalls calls, each at expected output, with input scaled up and growing per call', () => {
    // 2000 estimated input tokens; Haiku $1/M in, $5/M out.
    const { maxCalls, outputTokensPerCall, inputUndercountFactor, inputGrowthPerCallTokens } = AGENT_TURN_ESTIMATE
    let expected = 0
    for (let k = 0; k < maxCalls; k++) {
      expected += measured(2000 * inputUndercountFactor + k * inputGrowthPerCallTokens, outputTokensPerCall)
    }
    const { estimatedCost } = estimateAgentTurnCost({ model: HAIKU, estimatedInputTokens: 2000 })
    expect(estimatedCost).toBeCloseTo(expected, 5)
  })

  test('the constants are the calibrated ones - a change here must come with a re-cut fixture', () => {
    expect(AGENT_TURN_ESTIMATE).toEqual({
      maxCalls: 3,
      outputTokensPerCall: 512,
      inputUndercountFactor: 1.25,
      inputGrowthPerCallTokens: 800,
    })
  })

  test('covers the measured cost of every real turn on record', () => {
    for (const turn of fixture.turns) {
      const actual = turn.calls.reduce((sum, c) => sum + measured(c.input, c.output), 0)
      const { estimatedCost } = estimateAgentTurnCost({ model: HAIKU, estimatedInputTokens: turn.baseInputEstimate })
      expect(estimatedCost, `turn of ${turn.calls.length} call(s): estimate ${estimatedCost} vs actual ${actual}`).toBeGreaterThanOrEqual(actual)
    }
  })

  test('is far tighter than the per-call ceiling quote it replaces as the gate figure', () => {
    let estimateTotal = 0
    let ceilingTotal = 0
    for (const turn of fixture.turns) {
      estimateTotal += estimateAgentTurnCost({ model: HAIKU, estimatedInputTokens: turn.baseInputEstimate }).estimatedCost
      // The old figure: three calls, each reserved at the 8192-token output ceiling.
      ceilingTotal += 3 * quoteClaudeCall({ model: HAIKU, estimatedInputTokens: turn.baseInputEstimate, maxTokens: 8192 }).estimatedCost
    }
    expect(estimateTotal / ceilingTotal).toBeLessThan(0.25)
  })

  test('is not needlessly loose either: on average within 4x of what turns really cost', () => {
    let ratioSum = 0
    for (const turn of fixture.turns) {
      const actual = turn.calls.reduce((sum, c) => sum + measured(c.input, c.output), 0)
      ratioSum += estimateAgentTurnCost({ model: HAIKU, estimatedInputTokens: turn.baseInputEstimate }).estimatedCost / actual
    }
    expect(ratioSum / fixture.turns.length).toBeLessThan(4)
  })
})

test.describe('estimateExpectedCallCost / expectedImagePromptsOutputTokens', () => {
  test('expected output grows per shot and covers every recorded write_image_prompts call', () => {
    for (const call of fixture.imagePromptsCalls) {
      expect(expectedImagePromptsOutputTokens(call.shots), `${call.shots} shot(s)`).toBeGreaterThanOrEqual(call.output)
    }
    expect(expectedImagePromptsOutputTokens(8)).toBeGreaterThan(expectedImagePromptsOutputTokens(4))
  })

  test('the expected output is capped at the call\'s own max_tokens ceiling', () => {
    const capped = estimateExpectedCallCost({ model: HAIKU, estimatedInputTokens: 1000, expectedOutputTokens: 50_000, maxTokens: 8192 })
    const ceiling = quoteClaudeCall({ model: HAIKU, estimatedInputTokens: 1000 * AGENT_TURN_ESTIMATE.inputUndercountFactor, maxTokens: 8192 })
    expect(capped).toBeCloseTo(ceiling.estimatedCost, 6)
  })

  test('input is scaled by the same undercount factor as the turn estimate', () => {
    const cost = estimateExpectedCallCost({ model: HAIKU, estimatedInputTokens: 2000, expectedOutputTokens: 100, maxTokens: 8192 })
    expect(cost).toBeCloseTo(measured(2000 * AGENT_TURN_ESTIMATE.inputUndercountFactor, 100), 6)
  })
})
