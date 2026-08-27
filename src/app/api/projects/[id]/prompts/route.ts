import { NextResponse } from 'next/server'
import type Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createClaudeClient, logClaudeUsage } from '@/lib/claude'
import { modelsConfig } from '@/lib/config/models'
import { acquireGenerationLock, releaseGenerationLock } from '@/lib/generation-lock'
import { needsPrompts, resolvePromptResults } from './logic'

const PROMPTS_SYSTEM_PROMPT = `You are writing per-shot image and video prompts for a short narrated video, based on its script.

Write prompts as structured data via the write_prompts tool - never as free-text JSON in your reply. Call write_prompts exactly once with one entry per requested shot_key.

image_prompt is a detailed, self-contained description of that shot's image (~800-1200 characters) - it must make sense with no other context, since it goes straight to an image generation model.

video_prompt describes the motion within that shot's image (~400-700 characters) - what moves, how the camera behaves - not a new shot.

Use the full script below only for continuity (recurring characters, setting, visual style) between shots - do not write prompts for any shot_key not explicitly requested.`

const WRITE_PROMPTS_TOOL: Anthropic.Tool = {
  name: 'write_prompts',
  description: 'Write image_prompt and video_prompt for the requested shots only.',
  input_schema: {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            shot_key: {
              type: 'string',
              description: "The shot's identifier, e.g. 's001'.",
            },
            image_prompt: {
              type: 'string',
              description: 'Detailed, self-contained image description (~800-1200 characters).',
            },
            video_prompt: {
              type: 'string',
              description: "Describes motion within this shot's image (~400-700 characters).",
            },
          },
          required: ['shot_key', 'image_prompt', 'video_prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['prompts'],
    additionalProperties: false,
  },
  strict: true,
  cache_control: { type: 'ephemeral' },
}

function buildPromptsDynamicBlock(
  allShots: { shot_key: string; voice_over: string }[],
  targetKeys: string[]
) {
  return `Full script for context (in order):\n${JSON.stringify(allShots, null, 2)}\n\nWrite image_prompt and video_prompt only for these shot_keys: ${targetKeys.join(', ')}.`
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

  const lockAcquired = await acquireGenerationLock(supabase, projectId, user.id)
  if (!lockAcquired) {
    return NextResponse.json(
      { error: 'A generation is already in progress for this project.' },
      { status: 409 }
    )
  }

  try {
    return await handlePromptsGeneration(supabase, projectId)
  } finally {
    await releaseGenerationLock(supabase, projectId)
  }
}

async function handlePromptsGeneration(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string
) {
  const { data: allShots, error: shotsError } = await supabase
    .from('shots')
    .select('id, shot_key, voice_over, image_prompt, video_prompt')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })

  if (shotsError) {
    return NextResponse.json({ error: shotsError.message }, { status: 500 })
  }

  const shotsNeedingPrompts = (allShots ?? []).filter(
    (s): s is typeof s & { shot_key: string } => s.shot_key !== null && needsPrompts(s)
  )

  if (shotsNeedingPrompts.length === 0) {
    const { error: projectUpdateError } = await supabase
      .from('projects')
      .update({ current_step: 'voiceover', status: 'in_progress' })
      .eq('id', projectId)

    if (projectUpdateError) {
      return NextResponse.json({ error: projectUpdateError.message }, { status: 500 })
    }

    return NextResponse.json({ shots: allShots ?? [] })
  }

  const claude = createClaudeClient()
  const response = await claude.messages.create({
    model: modelsConfig.prompts.model,
    max_tokens: modelsConfig.prompts.maxTokens,
    system: [
      { type: 'text', text: PROMPTS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: buildPromptsDynamicBlock(
          (allShots ?? [])
            .filter((s): s is typeof s & { shot_key: string } => s.shot_key !== null)
            .map(({ shot_key, voice_over }) => ({ shot_key, voice_over })),
          shotsNeedingPrompts.map((s) => s.shot_key)
        ),
      },
    ],
    tools: [WRITE_PROMPTS_TOOL],
    tool_choice: { type: 'tool', name: 'write_prompts' },
    messages: [{ role: 'user', content: 'Generate the image and video prompts now.' }],
  })

  await logClaudeUsage(supabase, projectId, 'prompts', modelsConfig.prompts.model, response.usage)

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === 'write_prompts'
  )

  if (!toolUseBlock) {
    return NextResponse.json({ error: 'Claude did not return prompts' }, { status: 500 })
  }

  const input = toolUseBlock.input as { prompts?: unknown }
  const idByKey = new Map(shotsNeedingPrompts.map((s) => [s.shot_key, s.id]))
  const { validEntries, missingShotKeys } = resolvePromptResults(
    input.prompts,
    shotsNeedingPrompts.map((s) => s.shot_key)
  )

  const updateResults = await Promise.all(
    validEntries.map((entry) =>
      supabase
        .from('shots')
        .update({ image_prompt: entry.image_prompt, video_prompt: entry.video_prompt })
        .eq('id', idByKey.get(entry.shot_key)!)
    )
  )

  const updateError = updateResults.find((r) => r.error)?.error
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  const { data: refreshedShots, error: refreshError } = await supabase
    .from('shots')
    .select('*')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })

  if (refreshError) {
    return NextResponse.json({ error: refreshError.message }, { status: 500 })
  }

  if (missingShotKeys.length > 0) {
    return NextResponse.json(
      {
        error: `Claude couldn't generate usable prompts for: ${missingShotKeys.join(', ')}. Try again.`,
        missingShotKeys,
        shots: refreshedShots ?? [],
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

  return NextResponse.json({ shots: refreshedShots ?? [] })
}
