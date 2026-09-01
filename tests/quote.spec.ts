import { test, expect } from '@playwright/test'
import type Anthropic from '@anthropic-ai/sdk'
import { estimateInputTokens } from '../src/lib/usage/quote'

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
})
