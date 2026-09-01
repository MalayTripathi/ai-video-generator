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
  test('emits maxItems equal to the passed targetShots', () => {
    expect(shotsSchema(buildWriteShotsTool(8)).maxItems).toBe(8)
    expect(shotsSchema(buildWriteShotsTool(75)).maxItems).toBe(75)
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
