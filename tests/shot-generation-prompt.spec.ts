import type Anthropic from '@anthropic-ai/sdk'
import { test, expect } from '@playwright/test'
import { buildWriteShotsTool, buildShotsDynamicBlock } from '../src/lib/prompts/shot-generation'

// Anthropic.Tool.input_schema.properties is typed `unknown` by the SDK (it's a raw JSON
// schema) - narrow just the one property this suite inspects.
function shotsSchema(tool: Anthropic.Tool): { maxItems?: number; minItems?: number; description?: string } {
  return (tool.input_schema.properties as { shots: { maxItems?: number; minItems?: number; description?: string } })
    .shots
}

test.describe('buildWriteShotsTool', () => {
  // The tool-use API supports no array-count upper bound (only minItems of 0 or 1) - see
  // tests/tool-schema-keywords.spec.ts. A maxItems here would 400 on every real call, so
  // targetShots is enforced by the description and system prompt wording instead.
  test('never emits maxItems - the API has no array-count upper bound', () => {
    expect(shotsSchema(buildWriteShotsTool(8)).maxItems).toBeUndefined()
    expect(shotsSchema(buildWriteShotsTool(75)).maxItems).toBeUndefined()
  })

  test('states the maximum explicitly in the shots array description', () => {
    expect(shotsSchema(buildWriteShotsTool(15)).description).toContain('15')
  })

  test('keeps minItems at 1 regardless of targetShots', () => {
    expect(shotsSchema(buildWriteShotsTool(8)).minItems).toBe(1)
    expect(shotsSchema(buildWriteShotsTool(75)).minItems).toBe(1)
  })
})

test.describe('buildShotsDynamicBlock', () => {
  test('states the target shot count as a hard maximum', () => {
    const block = buildShotsDynamicBlock(
      { source_text: 'A short film about a lighthouse.', video_type: 'auto', language: 'en' },
      8
    )
    expect(block).toContain('up to 8 shots')
    expect(block).toContain('hard maximum')
  })
})
