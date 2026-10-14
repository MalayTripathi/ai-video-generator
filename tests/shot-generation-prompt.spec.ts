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

  test('states the slot count in the shots array description', () => {
    expect(arraySchema(buildChunkWriteShotsTool(5), 'shots').description).toContain('Exactly 5 shots')
  })

  test('asks whether the scene is complete, and never for a length - lengths are code-owned slots', () => {
    const tool = buildChunkWriteShotsTool(8)
    expect(tool.input_schema.required).toContain('scene_complete')
    const item = (arraySchema(tool, 'shots') as unknown as { items: { required: string[] } }).items
    expect(item.required).not.toContain('duration_sec')
  })
})

test.describe('the outline', () => {
  test("asks for scenes whose seconds add up to the tier target, with a shot count each, inside the model's shot lengths", () => {
    const block = buildOutlineDynamicBlock({ source_text: 'A short film about a lighthouse.', video_type: 'auto', language: 'en' }, 90, { min: 5, max: 10 })
    expect(block).toContain('Target length: 90 seconds')
    expect(block).toContain('Shot length range: 5 to 10 seconds')
    expect(arraySchema(WRITE_OUTLINE_TOOL, 'scenes').minItems).toBe(1)
    const scene = (arraySchema(WRITE_OUTLINE_TOOL, 'scenes') as unknown as { items: { required: string[] } }).items
    expect(scene.required).toContain('shot_count')
  })
})

test.describe('buildChunkUserMessage', () => {
  test('carries the scene, its elements, the shot before, and each slot with its length and word cap', () => {
    const message = buildChunkUserMessage({
      scene: { position: 2, title: 'The Storm', summary: 'Waves rise.', location: 'Cliff', time_of_day: 'night', target_seconds: 20 },
      elementNames: ['Mara', 'Lighthouse'],
      previousShot: { voice_over: 'She climbed the stairs.', visual_description: 'Spiral stairs.' },
      slots: [
        { seconds: 7, wordCap: 14 },
        { seconds: 6, wordCap: 12 },
      ],
      firstSlot: 2,
      sceneSlots: 3,
    })
    expect(message).toContain('Scene 3: The Storm')
    expect(message).toContain('Mara, Lighthouse')
    expect(message).toContain('She climbed the stairs.')
    expect(message).toContain('Shot slots 2-3 of this scene\'s 3 - these finish the scene')
    expect(message).toContain('2. 7s - at most 14 words of narration and dialogue together')
    expect(message).toContain('3. 6s - at most 12 words of narration and dialogue together')
    expect(message).toContain('Write exactly 2 shots')
  })

  test('a chunk that leaves slots for later does not say it finishes the scene', () => {
    const message = buildChunkUserMessage({
      scene: { position: 0, title: 'Open', summary: null, location: null, time_of_day: null, target_seconds: 30 },
      elementNames: [],
      previousShot: null,
      slots: [{ seconds: 5, wordCap: 10 }],
      firstSlot: 1,
      sceneSlots: 4,
    })
    expect(message).toContain('Shot slots 1-1 of this scene\'s 4:')
    expect(message).not.toContain('these finish the scene')
  })
})
