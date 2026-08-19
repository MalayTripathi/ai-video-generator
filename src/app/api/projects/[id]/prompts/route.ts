import { NextResponse } from 'next/server'
import type Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createClaudeClient } from '@/lib/claude'
import { modelsConfig } from '@/lib/config/models'
import { needsPrompts, resolvePromptResults } from './logic'

const PROMPTS_SYSTEM_PROMPT = `You are writing per-scene image and video prompts for a short narrated video, based on its script.

Write prompts as structured data via the write_prompts tool - never as free-text JSON in your reply. Call write_prompts exactly once with one entry per requested scene_key.

image_prompt is a detailed, self-contained description of that scene's image (~800-1200 characters) - it must make sense with no other context, since it goes straight to an image generation model.

video_prompt describes the motion within that scene's image (~400-700 characters) - what moves, how the camera behaves - not a new scene.

Use the full script below only for continuity (recurring characters, setting, visual style) between scenes - do not write prompts for any scene_key not explicitly requested.`

const WRITE_PROMPTS_TOOL: Anthropic.Tool = {
  name: 'write_prompts',
  description: 'Write image_prompt and video_prompt for the requested scenes only.',
  input_schema: {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scene_key: {
              type: 'string',
              description: "The scene's identifier, e.g. 's001'.",
            },
            image_prompt: {
              type: 'string',
              description: 'Detailed, self-contained image description (~800-1200 characters).',
            },
            video_prompt: {
              type: 'string',
              description: "Describes motion within this scene's image (~400-700 characters).",
            },
          },
          required: ['scene_key', 'image_prompt', 'video_prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['prompts'],
    additionalProperties: false,
  },
  strict: true,
}

function buildPromptsSystemPrompt(
  allScenes: { scene_key: string; voice_over: string }[],
  targetKeys: string[]
) {
  return `${PROMPTS_SYSTEM_PROMPT}\n\nFull script for context (in order):\n${JSON.stringify(allScenes, null, 2)}\n\nWrite image_prompt and video_prompt only for these scene_keys: ${targetKeys.join(', ')}.`
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const { data: allScenes, error: scenesError } = await supabase
    .from('scenes')
    .select('id, scene_key, voice_over, image_prompt, video_prompt')
    .eq('project_id', projectId)
    .order('position', { ascending: true })

  if (scenesError) {
    return NextResponse.json({ error: scenesError.message }, { status: 500 })
  }

  const scenesNeedingPrompts = (allScenes ?? []).filter(
    (s): s is typeof s & { scene_key: string } => s.scene_key !== null && needsPrompts(s)
  )

  if (scenesNeedingPrompts.length === 0) {
    const { error: projectUpdateError } = await supabase
      .from('projects')
      .update({ current_step: 'voiceover', status: 'in_progress' })
      .eq('id', projectId)

    if (projectUpdateError) {
      return NextResponse.json({ error: projectUpdateError.message }, { status: 500 })
    }

    return NextResponse.json({ scenes: allScenes ?? [] })
  }

  const claude = createClaudeClient()
  const response = await claude.messages.create({
    model: modelsConfig.prompts.model,
    max_tokens: modelsConfig.prompts.maxTokens,
    system: buildPromptsSystemPrompt(
      (allScenes ?? [])
        .filter((s): s is typeof s & { scene_key: string } => s.scene_key !== null)
        .map(({ scene_key, voice_over }) => ({ scene_key, voice_over })),
      scenesNeedingPrompts.map((s) => s.scene_key)
    ),
    tools: [WRITE_PROMPTS_TOOL],
    tool_choice: { type: 'tool', name: 'write_prompts' },
    messages: [{ role: 'user', content: 'Generate the image and video prompts now.' }],
  })

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === 'write_prompts'
  )

  if (!toolUseBlock) {
    return NextResponse.json({ error: 'Claude did not return prompts' }, { status: 500 })
  }

  const input = toolUseBlock.input as { prompts?: unknown }
  const idByKey = new Map(scenesNeedingPrompts.map((s) => [s.scene_key, s.id]))
  const { validEntries, missingSceneKeys } = resolvePromptResults(
    input.prompts,
    scenesNeedingPrompts.map((s) => s.scene_key)
  )

  const updateResults = await Promise.all(
    validEntries.map((entry) =>
      supabase
        .from('scenes')
        .update({ image_prompt: entry.image_prompt, video_prompt: entry.video_prompt })
        .eq('id', idByKey.get(entry.scene_key)!)
    )
  )

  const updateError = updateResults.find((r) => r.error)?.error
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  const { data: refreshedScenes, error: refreshError } = await supabase
    .from('scenes')
    .select('*')
    .eq('project_id', projectId)
    .order('position', { ascending: true })

  if (refreshError) {
    return NextResponse.json({ error: refreshError.message }, { status: 500 })
  }

  if (missingSceneKeys.length > 0) {
    return NextResponse.json(
      {
        error: `Claude couldn't generate usable prompts for: ${missingSceneKeys.join(', ')}. Try again.`,
        missingSceneKeys,
        scenes: refreshedScenes ?? [],
      },
      { status: 422 }
    )
  }

  const { error: projectUpdateError } = await supabase
    .from('projects')
    .update({ current_step: 'voiceover', status: 'in_progress' })
    .eq('id', projectId)

  if (projectUpdateError) {
    return NextResponse.json({ error: projectUpdateError.message }, { status: 500 })
  }

  return NextResponse.json({ scenes: refreshedScenes ?? [] })
}
