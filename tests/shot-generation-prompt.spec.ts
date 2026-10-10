import type Anthropic from '@anthropic-ai/sdk'
import { test, expect } from '@playwright/test'
import { buildChunkUserMessage, buildChunkWriteShotsTool } from '../src/lib/prompts/shot-chunk'
import { WRITE_OUTLINE_TOOL, buildOutlineDynamicBlock } from '../src/lib/prompts/shot-outline'

// Anthropic.Tool.input_schema.properties is typed `unknown` by the SDK (it's a raw JSON
// schema) - narrow just the one property this suite inspects.
function arraySchema(tool: Anthropic.Tool, key: string): { maxItems?: number; minItems?: number; description?: string } {
  return (tool.input_schema.properties as Record<string, { maxItems?: number; minItems?: number; description?: string }>)[key]
}

test.describe('buildChunkWriteShotsTool', () => {
  // The tool-use API supports no array-count upper bound (only minItems of 0 or 1) - see
  // tests/tool-schema-keywords.spec.ts. The count is enforced in code, which saves only
  // the allowed shots.
  test('never emits maxItems - the API has no array-count upper bound', () => {
    expect(arraySchema(buildChunkWriteShotsTool(8), 'shots').maxItems).toBeUndefined()
  })

  test('states the chunk maximum in the shots array description', () => {
    expect(arraySchema(buildChunkWriteShotsTool(5), 'shots').description).toContain('5')
  })

  test('asks whether the scene is complete', () => {
    expect(buildChunkWriteShotsTool(8).input_schema.required).toContain('scene_complete')
  })
})

test.describe('the outline', () => {
  test('asks for scenes whose seconds add up to the tier target', () => {
    const block = buildOutlineDynamicBlock({ source_text: 'A short film about a lighthouse.', video_type: 'auto', language: 'en' }, 90)
    expect(block).toContain('Target length: 90 seconds')
    expect(arraySchema(WRITE_OUTLINE_TOOL, 'scenes').minItems).toBe(1)
  })
})

test.describe('buildChunkUserMessage', () => {
  test('carries the scene, its elements, the shot before, the cap and the split rule', () => {
    const message = buildChunkUserMessage({
      scene: { position: 2, title: 'The Storm', summary: 'Waves rise.', location: 'Cliff', time_of_day: 'night', target_seconds: 20 },
      elementNames: ['Mara', 'Lighthouse'],
      previousShot: { voice_over: 'She climbed the stairs.', visual_description: 'Spiral stairs.' },
      writtenSeconds: 6,
      maxShots: 8,
      maxWordsPerShot: 65,
    })
    expect(message).toContain('Scene 3: The Storm')
    expect(message).toContain('Mara, Lighthouse')
    expect(message).toContain('She climbed the stairs.')
    expect(message).toContain('about 14 seconds')
    expect(message).toContain('at most 8 shots')
    expect(message).toContain('longer than 65 words')
  })
})
