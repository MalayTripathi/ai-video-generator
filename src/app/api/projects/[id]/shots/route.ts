import { NextResponse } from 'next/server'
import type Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createClaudeGateway, logClaudeUsage, type ClaudeGateway } from '@/lib/claude'
import { modelsConfig } from '@/lib/config/models'
import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import { acquireGenerationLock, releaseGenerationLock } from '@/lib/generation-lock'
import { generateUniqueShotKeys, isUniqueViolation, MAX_SHOT_KEY_INSERT_ATTEMPTS } from '@/lib/shot-key'
import {
  SHOT_GENERATION_SYSTEM_PROMPT_V2,
  WRITE_SHOTS_TOOL,
  buildShotsDynamicBlock,
} from '@/lib/prompts/shot-generation'
import { parseRawShots, sanitizeEnum, type RawShot } from './logic'
import type { Tables } from '@/lib/database.types'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type ElementRow = Tables<'elements'>

const SHOT_SIZES = ['wide', 'full', 'medium', 'close_up', 'extreme_close_up'] as const
const CAMERA_ANGLES = ['eye_level', 'low', 'high', 'over_the_shoulder', 'top_down'] as const
const CAMERA_MOVEMENTS = [
  'static',
  'slow_push_in',
  'pull_out',
  'pan',
  'tilt',
  'orbit',
  'handheld',
] as const
const ELEMENT_TYPES = ['character', 'location', 'prop'] as const
const VIDEO_TYPES = [
  'narrated_story',
  'explainer',
  'facts_listicle',
  'character_drama',
  'product_ad',
  'trailer',
] as const

export const maxDuration = 300

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
    .select('id, source_text, video_type, language, duration_target, title')
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

  const gateway = createClaudeGateway()

  try {
    return await handleShotsGeneration(supabase, projectId, project, gateway)
  } finally {
    await releaseGenerationLock(supabase, projectId)
  }
}

async function handleShotsGeneration(
  supabase: SupabaseServerClient,
  projectId: string,
  project: {
    source_text: string | null
    video_type: string | null
    language: string | null
    duration_target: string | null
    title: string | null
  },
  gateway: ClaudeGateway
) {
  const targetShots =
    project.duration_target && project.duration_target in durationConfig
      ? durationConfig[project.duration_target as DurationTarget].targetShots
      : durationConfig['1-2min'].targetShots

  const { message, stopReason, requestId } = await gateway.createMessage({
    model: modelsConfig.shots.model,
    max_tokens: modelsConfig.shots.maxTokens,
    system: [
      { type: 'text', text: SHOT_GENERATION_SYSTEM_PROMPT_V2, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: buildShotsDynamicBlock(project, targetShots) },
    ],
    tools: [WRITE_SHOTS_TOOL],
    tool_choice: { type: 'tool', name: 'write_shots' },
    messages: [{ role: 'user', content: 'Generate the shot list now.' }],
  })

  await logClaudeUsage(supabase, projectId, 'shots', modelsConfig.shots.model, message.usage)
  // TODO(phase-1): persist stopReason/requestId once the usage table
  // supports a pending/settled row lifecycle (see CLAUDE.md's `usage`
  // "Known gaps" note) - for now just surface them in the server log.
  console.warn(`[shots] stopReason=${stopReason} requestId=${requestId}`)

  const toolUseBlock = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'write_shots'
  )

  if (!toolUseBlock) {
    return NextResponse.json({ error: 'Claude did not return a shot list' }, { status: 500 })
  }

  const input = toolUseBlock.input as {
    title?: unknown
    message?: unknown
    video_type?: unknown
    shots?: unknown
  }
  const validatedShots = parseRawShots(input.shots).map((shot) => ({
    ...shot,
    shot_size: sanitizeEnum(shot.shot_size, SHOT_SIZES),
    camera_angle: sanitizeEnum(shot.camera_angle, CAMERA_ANGLES),
    camera_movement: sanitizeEnum(shot.camera_movement, CAMERA_MOVEMENTS),
  }))

  if (validatedShots.length === 0) {
    return NextResponse.json(
      { error: "Couldn't build the shot list. The model returned nothing usable." },
      { status: 422 }
    )
  }

  const parsedTitle = typeof input.title === 'string' ? input.title.trim().slice(0, 60) || null : null
  const parsedMessage = typeof input.message === 'string' ? input.message.trim() : ''
  const parsedVideoType = sanitizeEnum(input.video_type, VIDEO_TYPES)

  // Dedup source of truth: reused across the whole request so two shots
  // naming the same new element resolve to one row, not one each. The
  // project's (project_id, lower(name)) unique index is only a race safety
  // net, not the primary mechanism - hence the sequential awaits below.
  const { data: existingElements, error: elementsFetchError } = await supabase
    .from('elements')
    .select('*')
    .eq('project_id', projectId)

  if (elementsFetchError) {
    return NextResponse.json({ error: elementsFetchError.message }, { status: 500 })
  }

  const elementsByLowerName = new Map<string, ElementRow>()
  for (const el of existingElements ?? []) {
    elementsByLowerName.set(el.name.toLowerCase(), el)
  }

  async function resolveElement(
    name: string,
    type: string,
    description: string | null
  ): Promise<ElementRow> {
    const key = name.trim().toLowerCase()
    const existing = elementsByLowerName.get(key)
    if (existing) return existing

    const { data, error } = await supabase
      .from('elements')
      .insert({
        project_id: projectId,
        name: name.trim(),
        type,
        description: description?.trim() || null,
      })
      .select('*')
      .single()

    if (error) {
      if (isUniqueViolation(error)) {
        const { data: raced } = await supabase
          .from('elements')
          .select('*')
          .eq('project_id', projectId)
          .ilike('name', name.trim())
          .single()
        if (raced) {
          elementsByLowerName.set(key, raced)
          return raced
        }
      }
      throw new Error(error.message)
    }

    elementsByLowerName.set(key, data)
    return data
  }

  type ShotBuild = {
    shot: RawShot
    elementIds: string[]
    elementsForResponse: ElementRow[]
    dialogueResolved: { element_id: string; element_name: string; line: string }[]
  }

  const shotBuilds: ShotBuild[] = []

  try {
    for (const shot of validatedShots) {
      const elementIds = new Set<string>()
      const elementsForResponse: ElementRow[] = []

      for (const ref of shot.element_names) {
        const type = sanitizeEnum(ref.type, ELEMENT_TYPES) ?? 'prop'
        const el = await resolveElement(ref.name, type, ref.description)
        if (!elementIds.has(el.id)) {
          elementIds.add(el.id)
          elementsForResponse.push(el)
        }
      }

      const dialogueResolved: { element_id: string; element_name: string; line: string }[] = []
      for (const line of shot.dialogue) {
        const el = await resolveElement(line.speaker_name, 'character', null)
        if (!elementIds.has(el.id)) {
          elementIds.add(el.id)
          elementsForResponse.push(el)
        }
        dialogueResolved.push({ element_id: el.id, element_name: el.name, line: line.line })
      }

      shotBuilds.push({ shot, elementIds: [...elementIds], elementsForResponse, dialogueResolved })
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to resolve elements' },
      { status: 500 }
    )
  }

  let insertedShots: Tables<'shots'>[] | null = null
  let insertError: { message: string } | null = null

  for (let attempt = 0; attempt < MAX_SHOT_KEY_INSERT_ATTEMPTS; attempt++) {
    const shotKeys = generateUniqueShotKeys(validatedShots.length)
    const rows = validatedShots.map((shot, index) => ({
      project_id: projectId,
      order_index: index,
      shot_key: shotKeys[index],
      voice_over: shot.voice_over,
      visual_description: shot.visual_description || null,
      shot_size: shot.shot_size,
      camera_angle: shot.camera_angle,
      camera_movement: shot.camera_movement,
      duration_sec: shot.duration_sec,
      section_label: shot.section_label,
      duration_locked: false,
      camera_overridden: false,
    }))

    const { data, error } = await supabase.from('shots').insert(rows).select('*')

    if (!error) {
      insertedShots = (data ?? []).sort((a, b) => a.order_index - b.order_index)
      insertError = null
      break
    }

    if (!isUniqueViolation(error)) {
      insertError = error
      break
    }
    insertError = error
  }

  if (!insertedShots) {
    return NextResponse.json(
      { error: insertError?.message ?? 'Failed to insert shots' },
      { status: 500 }
    )
  }

  const shotElementRows = insertedShots.flatMap((shotRow, index) =>
    shotBuilds[index].elementIds.map((elementId) => ({ shot_id: shotRow.id, element_id: elementId }))
  )

  if (shotElementRows.length > 0) {
    const { error: shotElementsError } = await supabase.from('shot_elements').insert(shotElementRows)
    if (shotElementsError) {
      return NextResponse.json({ error: shotElementsError.message }, { status: 500 })
    }
  }

  const dialogueUpdates = insertedShots
    .map((shotRow, index) => ({ shotRow, dialogue: shotBuilds[index].dialogueResolved }))
    .filter(({ dialogue }) => dialogue.length > 0)

  const dialogueResults = await Promise.all(
    dialogueUpdates.map(({ shotRow, dialogue }) =>
      supabase
        .from('shots')
        .update({ dialogue: dialogue.map(({ element_id, line }) => ({ element_id, line })) })
        .eq('id', shotRow.id)
    )
  )
  const dialogueError = dialogueResults.find((r) => r.error)?.error
  if (dialogueError) {
    return NextResponse.json({ error: dialogueError.message }, { status: 500 })
  }

  // Guarded: only write the title if the user hasn't set one since creation
  // (still null, matching createProjectFromIntake's title: null on insert).
  if (parsedTitle && project.title === null) {
    await supabase.from('projects').update({ title: parsedTitle }).eq('id', projectId).is('title', null)
  }
  const appliedTitle = project.title ?? parsedTitle

  // Guarded: only resolve video_type when the user left it on auto-detect;
  // never overwrite a type chosen explicitly at intake.
  if (parsedVideoType && project.video_type === 'auto') {
    await supabase
      .from('projects')
      .update({ video_type: parsedVideoType })
      .eq('id', projectId)
      .eq('video_type', 'auto')
  }
  const appliedVideoType =
    project.video_type === 'auto' ? (parsedVideoType ?? project.video_type) : project.video_type

  if (parsedMessage) {
    await supabase
      .from('messages')
      .insert({ project_id: projectId, role: 'assistant', content: parsedMessage })
  }

  return NextResponse.json({
    title: appliedTitle,
    message: parsedMessage,
    video_type: appliedVideoType,
    shots: insertedShots.map((shotRow, index) => ({
      id: shotRow.id,
      order_index: shotRow.order_index,
      shot_key: shotRow.shot_key,
      section_label: shotRow.section_label,
      voice_over: shotRow.voice_over,
      visual_description: shotRow.visual_description,
      duration_sec: shotRow.duration_sec,
      duration_locked: shotRow.duration_locked,
      shot_size: shotRow.shot_size,
      camera_angle: shotRow.camera_angle,
      camera_movement: shotRow.camera_movement,
      dialogue: shotBuilds[index].dialogueResolved,
      elements: shotBuilds[index].elementsForResponse.map((el) => ({
        id: el.id,
        name: el.name,
        type: el.type,
        status: el.status,
        reference_image_path: el.reference_image_path,
      })),
    })),
  })
}
