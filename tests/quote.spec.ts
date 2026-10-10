import { test, expect } from '@playwright/test'
import type Anthropic from '@anthropic-ai/sdk'
import { estimateInputTokens, quoteClaudeCall, QUOTE_TIER_HEADROOM } from '../src/lib/usage/quote'
import { buildChunkWriteShotsTool } from '../src/lib/prompts/shot-chunk'

const SMALL_TOOL: Anthropic.Tool = {
  name: 'small_tool',
  description: 'A tiny tool.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
}

const LARGE_TOOL: Anthropic.Tool = {
  name: 'large_tool',
  description:
    'A tool with a much larger serialised schema, closer in shape to a real write_shots-style tool call - ' +
    'lots of properties, nested objects, and enums, to make sure the schema bytes actually move the estimate.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title.' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            kind: { type: 'string', enum: ['a', 'b', 'c', 'd', 'e'] },
            description: { type: 'string', description: 'A longer field description to pad the schema size.' },
            nested: {
              type: 'object',
              properties: {
                foo: { type: 'string' },
                bar: { type: 'number' },
                baz: { type: 'boolean' },
              },
              required: ['foo', 'bar', 'baz'],
              additionalProperties: false,
            },
          },
          required: ['name', 'kind', 'description', 'nested'],
          additionalProperties: false,
        },
      },
    },
    required: ['title', 'items'],
    additionalProperties: false,
  },
}

test.describe('estimateInputTokens', () => {
  test('grows when the serialised tool schema grows, for the same text', () => {
    const texts = ['A fixed system prompt.', 'A fixed user message.']

    const withSmallSchema = estimateInputTokens({ texts, tools: [SMALL_TOOL] })
    const withLargeSchema = estimateInputTokens({ texts, tools: [LARGE_TOOL] })

    expect(withLargeSchema).toBeGreaterThan(withSmallSchema)
  })

  test('a call with tools costs more than the identical call with no tools', () => {
    const texts = ['A fixed system prompt.', 'A fixed user message.']

    const withNoTools = estimateInputTokens({ texts, tools: [] })
    const withTools = estimateInputTokens({ texts, tools: [SMALL_TOOL] })

    // Both the schema's own chars and the fixed tool-use overhead constant should push
    // the estimate up once tools are present.
    expect(withTools).toBeGreaterThan(withNoTools)
  })

  test('counts the system text and the user message, not just the first text block', () => {
    const short = estimateInputTokens({ texts: ['short'], tools: [] })
    const withUserMessage = estimateInputTokens({
      texts: ['short', 'a much, much longer user message that should meaningfully increase the character count'],
      tools: [],
    })

    expect(withUserMessage).toBeGreaterThan(short)
  })

  test('picks up the real write_shots tool schema per call - the estimate differs across chunk caps', () => {
    const texts = ['A fixed system prompt.', 'A fixed user message.']

    const withSmallTarget = estimateInputTokens({ texts, tools: [buildChunkWriteShotsTool(8)] })
    // A wide gap in digit count, not a realistic chunk cap - the schema has no
    // maxItems to vary by (the tool-use API doesn't support one; see
    // tests/tool-schema-keywords.spec.ts), so the only thing that varies with
    // the cap is the description text's own digit count. A small gap (8 vs 75)
    // is only a 1-character difference, which the chars/4 heuristic can round away; this
    // gap is wide enough to survive that rounding regardless.
    const withLargeTarget = estimateInputTokens({ texts, tools: [buildChunkWriteShotsTool(750_000)] })

    // estimateInputTokens must reflect the actual per-call schema passed to it, not a
    // stale/shared one.
    expect(withLargeTarget).not.toBe(withSmallTarget)
  })
})

test.describe('quoteClaudeCall: rate card headroom', () => {
  test('an estimate that could really cross 100,000 tokens is quoted on the long card', () => {
    // 70,000 estimated x 1.5 headroom = 105,000 > 100,000: priced long, so the newer
    // tokenizer's ~30% undercount can never overrun the reservation.
    expect(QUOTE_TIER_HEADROOM).toBe(1.5)
    const near = quoteClaudeCall({ model: 'claude-haiku-5-5', estimatedInputTokens: 70_000, maxTokens: 1_000 })
    expect(near.estimatedCost).toBeCloseTo(0.07 * 0.5 + 0.001 * 2.5, 9)
    const far = quoteClaudeCall({ model: 'claude-haiku-5-5', estimatedInputTokens: 60_000, maxTokens: 1_000 })
    expect(far.estimatedCost).toBeCloseTo(0.06 * 0.1 + 0.001 * 0.5, 9)
  })
})
