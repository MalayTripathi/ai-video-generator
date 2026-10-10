import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { scriptedGateway, successMessage } from './helpers/claude-fakes'
import { CAMERA_FIELD_NAMES } from '../src/lib/prompts/camera-derivation'
import { runCameraDerivation } from '../src/app/api/projects/[id]/shots/[shotId]/camera/logic'
import { CLAUDE_REASONING_MODELS, claudeReasoningParams, modelsConfig, type ClaudeReasoning } from '../src/lib/config/models'

// Thinking and effort are set explicitly per operation, never left to the model default,
// and only sent to a model whose reasoning is tuned (CLAUDE_REASONING_MODELS).

const CLAUDE_SECTIONS = {
  shotOutline: modelsConfig.shotOutline,
  shots: modelsConfig.shots,
  camera: modelsConfig.camera,
  agent: modelsConfig.agent,
  imagePrompts: modelsConfig.imagePrompts,
  musicPrompt: modelsConfig.musicPrompt,
}
// Every route but the agent forces its tool call, which skips thinking on Haiku 5.5.
const FORCED_TOOL_SECTIONS = ['shotOutline', 'shots', 'camera', 'imagePrompts', 'musicPrompt'] as const

const EXPECTED: Record<keyof typeof CLAUDE_SECTIONS, ClaudeReasoning> = {
  shotOutline: { thinking: 'disabled', effort: 'medium' },
  shots: { thinking: 'disabled', effort: 'medium' },
  camera: { thinking: 'disabled', effort: 'low' },
  agent: { thinking: 'adaptive', effort: 'medium' },
  imagePrompts: { thinking: 'disabled', effort: 'medium' },
  musicPrompt: { thinking: 'disabled', effort: 'low' },
}

test.describe('Claude reasoning config', () => {
  test('every Claude operation sets thinking and effort explicitly', () => {
    for (const [name, section] of Object.entries(CLAUDE_SECTIONS)) {
      expect(section.reasoning, name).toEqual(EXPECTED[name as keyof typeof CLAUDE_SECTIONS])
    }
  })

  test('forced-tool operations run with thinking disabled, and disabled is never paired with xhigh/max (a 400)', () => {
    for (const name of FORCED_TOOL_SECTIONS) expect(CLAUDE_SECTIONS[name].reasoning.thinking, name).toBe('disabled')
    for (const [name, section] of Object.entries(CLAUDE_SECTIONS)) {
      if (section.reasoning.thinking === 'disabled') expect(['low', 'medium', 'high'], name).toContain(section.reasoning.effort)
    }
  })

  test('the params reach claude-haiku-5-5 only - Sonnet 5 and Haiku 4.5 requests are unchanged', () => {
    expect([...CLAUDE_REASONING_MODELS]).toEqual(['claude-haiku-5-5'])
    const reasoning: ClaudeReasoning = { thinking: 'disabled', effort: 'low' }
    expect(claudeReasoningParams({ model: 'claude-haiku-5-5', reasoning })).toEqual({
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
    })
    expect(claudeReasoningParams({ model: 'claude-sonnet-5', reasoning })).toEqual({})
    expect(claudeReasoningParams({ model: 'claude-haiku-4-5-20251001', reasoning })).toEqual({})
  })

  test('the camera request carries its thinking and effort', async () => {
    // Pinned here: a developer's .env.local may still point CLAUDE_CAMERA_MODEL elsewhere.
    const configured = modelsConfig.camera.model
    modelsConfig.camera.model = 'claude-haiku-5-5'
    try {
      const { data: project, error } = await admin
        .from('projects')
        .insert({
          user_id: primary.user.id,
          title: 'Reasoning test',
          current_step: 'workbench',
          furthest_step: stepIndex('workbench'),
        })
        .select('id')
        .single()
      expect(error).toBeNull()
      const { data: shot } = await admin
        .from('shots')
        .insert({
          project_id: project!.id,
          order_index: 0,
          shot_key: 'bcdfg',
          voice_over: 'A line.',
          visual_description: 'A wide shot.',
        })
        .select('id')
        .single()
      const gateway = scriptedGateway([successMessage({ shot_size: 'wide', shot_size_origin: 'derived' }, 'derive_camera')])

      await runCameraDerivation({
        gateway,
        supabase: admin,
        projectId: project!.id,
        shotId: shot!.id,
        userId: primary.user.id,
        fields: [...CAMERA_FIELD_NAMES],
        attemptId: crypto.randomUUID(),
        recordFixedSpend: async () => {},
      })
      const sent = gateway.getCalls()[0] as unknown as Record<string, unknown>
      expect(sent.model).toBe('claude-haiku-5-5')
      expect(sent.thinking).toEqual({ type: 'disabled' })
      expect(sent.output_config).toEqual({ effort: 'low' })
    } finally {
      modelsConfig.camera.model = configured
    }
  })
})
