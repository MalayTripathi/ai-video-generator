import { NextResponse } from 'next/server'
import type Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createClaudeClient } from '@/lib/claude'
import { modelsConfig } from '@/lib/config/models'

type Scene = {
  scene_key: string
  voice_over: string
  image_prompt: string
  video_prompt: string
}

const SYSTEM_PROMPT = `You are scripting a short narrated video with Claude's help.

Write scenes as structured data via the write_scenes tool - never as free-text JSON in your reply. Whenever you are generating a new script or revising the existing one, call write_scenes with the complete, current set of scenes (not just the ones that changed) and a brief message explaining what you did.

Each scene's voice_over starts with an inline delivery tag in square brackets, chosen from: [slowly], [warmly], [excited], [serious], [emotional], [calmly], [worried]. The tag is the first thing in the string.

image_prompt is a detailed, self-contained description of that scene's image (~800-1200 characters) - it must make sense with no other context, since it goes straight to an image generation model.

video_prompt describes the motion within that scene's image (~400-700 characters) - what moves, how the camera behaves - not a new scene.

Voiceover may be written in any language the user asks for.

Do NOT estimate or invent scene durations - that is measured later from the generated audio, not from the script.

If the user is just asking a question or chatting without requesting a script change, respond normally and do not call write_scenes.`

const WRITE_SCENES_TOOL: Anthropic.Tool = {
  name: 'write_scenes',
  description:
    "Write or replace the full set of scenes for the video script, in order. Always pass every scene that should exist after this turn, not just the ones that changed.",
  input_schema: {
    type: 'object',
    properties: {
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scene_key: {
              type: 'string',
              description: "Scene identifier in 's001' format, sequential.",
            },
            voice_over: {
              type: 'string',
              description:
                'Narration for this scene, starting with an inline delivery tag like [slowly].',
            },
            image_prompt: {
              type: 'string',
              description: 'Detailed, self-contained image description (~800-1200 characters).',
            },
            video_prompt: {
              type: 'string',
              description:
                "Describes motion within this scene's image (~400-700 characters).",
            },
          },
          required: ['scene_key', 'voice_over', 'image_prompt', 'video_prompt'],
          additionalProperties: false,
        },
      },
      message: {
        type: 'string',
        description:
          'A brief, conversational reply to the user explaining what changed - 1-2 sentences.',
      },
    },
    required: ['scenes', 'message'],
    additionalProperties: false,
  },
  strict: true,
}

function buildSystemPrompt(currentScenes: Scene[]) {
  const scenesBlock =
    currentScenes.length > 0
      ? JSON.stringify(currentScenes, null, 2)
      : 'No scenes yet - this is the first script generation for this project.'

  return `${SYSTEM_PROMPT}\n\nCurrent scenes:\n${scenesBlock}`
}

function isScene(value: unknown): value is Scene {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.scene_key === 'string' &&
    typeof v.voice_over === 'string' &&
    typeof v.image_prompt === 'string' &&
    typeof v.video_prompt === 'string'
  )
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  let message: unknown
  try {
    ;({ message } = await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof message !== 'string' || !message.trim()) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 })
  }

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

  const { error: insertUserMessageError } = await supabase
    .from('messages')
    .insert({ project_id: projectId, role: 'user', content: message })

  if (insertUserMessageError) {
    return NextResponse.json({ error: insertUserMessageError.message }, { status: 500 })
  }

  const [{ data: history, error: historyError }, { data: existingScenes, error: scenesError }] =
    await Promise.all([
      supabase
        .from('messages')
        .select('role, content')
        .eq('project_id', projectId)
        .order('created_at', { ascending: true }),
      supabase
        .from('scenes')
        .select('position, scene_key, voice_over, image_prompt, video_prompt')
        .eq('project_id', projectId)
        .order('position', { ascending: true }),
    ])

  if (historyError) {
    return NextResponse.json({ error: historyError.message }, { status: 500 })
  }
  if (scenesError) {
    return NextResponse.json({ error: scenesError.message }, { status: 500 })
  }

  const claude = createClaudeClient()
  const response = await claude.messages.create({
    model: modelsConfig.script.model,
    max_tokens: modelsConfig.script.maxTokens,
    system: buildSystemPrompt(existingScenes ?? []),
    tools: [WRITE_SCENES_TOOL],
    messages: (history ?? []).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  })

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === 'write_scenes'
  )

  let assistantMessage = ''
  if (toolUseBlock) {
    const toolMessage = (toolUseBlock.input as { message?: unknown }).message
    assistantMessage = typeof toolMessage === 'string' ? toolMessage : ''
  } else {
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    )
    assistantMessage = textBlock?.text ?? ''
  }

  let finalScenes: unknown[] = existingScenes ?? []

  if (toolUseBlock) {
    const input = toolUseBlock.input as { scenes?: unknown }
    const scenes = Array.isArray(input.scenes) ? input.scenes.filter(isScene) : []

    const rows = scenes.map((scene, index) => ({
      project_id: projectId,
      position: index + 1,
      scene_key: scene.scene_key,
      voice_over: scene.voice_over,
      image_prompt: scene.image_prompt,
      video_prompt: scene.video_prompt,
    }))

    if (rows.length > 0) {
      const { error: upsertError } = await supabase
        .from('scenes')
        .upsert(rows, { onConflict: 'project_id,position' })

      if (upsertError) {
        return NextResponse.json({ error: upsertError.message }, { status: 500 })
      }
    }

    const { error: deleteError } = await supabase
      .from('scenes')
      .delete()
      .eq('project_id', projectId)
      .gt('position', rows.length)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    const { data: refreshedScenes, error: refreshError } = await supabase
      .from('scenes')
      .select('*')
      .eq('project_id', projectId)
      .order('position', { ascending: true })

    if (refreshError) {
      return NextResponse.json({ error: refreshError.message }, { status: 500 })
    }

    finalScenes = refreshedScenes ?? []
  }

  if (assistantMessage.trim()) {
    const { error: insertAssistantMessageError } = await supabase
      .from('messages')
      .insert({ project_id: projectId, role: 'assistant', content: assistantMessage })

    if (insertAssistantMessageError) {
      return NextResponse.json({ error: insertAssistantMessageError.message }, { status: 500 })
    }
  } else {
    console.log(
      `[script route] empty assistant message for project ${projectId} - skipping messages insert`
    )
  }

  return NextResponse.json({ message: assistantMessage, scenes: finalScenes })
}
