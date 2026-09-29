import type Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import type { Json, Tables } from '@/lib/database.types'
import type { ClaudeGateway } from '@/lib/claude'
// Type-only, like every paid route's logic.ts: the route injects the real functions, so a
// plain-Node test can pass fakes and this file adds no service-role import.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import type { mintAttemptId as mintAttemptIdType, recordFixedSpend as recordFixedSpendType } from '@/lib/credits/ledger'
import type { MusicGateway } from '@/lib/music/gateway'
import { creditsFor } from '@/lib/config/credits'
import { modelsConfig } from '@/lib/config/models'
import type { UsageBreakdown } from '@/lib/config/pricing'
import {
  MUSIC_STALE_AFTER_MS,
  MUSIC_UPLOAD_FORMATS,
  MUSIC_UPLOAD_MAX_BYTES,
  MUSIC_UPLOAD_MAX_SEC,
} from '@/lib/config/storyboard'
import { claimGeneration, peekGenerationPayload, persistGenerationPayload, settleGeneration } from '@/lib/generations/claim'
import {
  AllowanceExceededError,
  assertWithinAllowance,
  estimateInputTokens,
  quoteClaudeCall,
  reserveUsage,
  settleUsage,
} from '@/lib/usage'
import { quoteElevenLabsCall } from '@/lib/usage/quote'
import { measureDurationSec } from '@/lib/voiceover/audio'
import { requestedMusicSec } from '@/lib/music/length'
import { buildScript } from '@/lib/storyboard/voiceover'
import { laneShots, laneTotalSeconds } from '@/lib/storyboard/timeline'
import {
  buildMusicStyleBlock,
  cleanMusicStyle,
  MUSIC_STYLE_PROMPT_V1,
  WRITE_MUSIC_STYLE_TOOL,
} from '@/lib/prompts/music-style'
import { errorMessage, gate, getObject, loadEditableProject, putObject, type Refusal } from '../voiceover/logic'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type GenerationRow = Tables<'generations'>

const STEP = 'storyboard' as const
const GENERATE = 'background_music' as const
const DERIVE = 'derive_music_prompt' as const

export function musicDir(userId: string, projectId: string): string {
  return `${userId}/${projectId}/music`
}

/** The picture's in-film length now - what a music request is sized to. */
async function loadPictureSec(
  supabase: SupabaseServerClient,
  projectId: string
): Promise<{ seconds: number } | { error: string }> {
  const { data, error } = await supabase
    .from('shots')
    .select('duration_sec, film_duration_sec, binned_at')
    .eq('project_id', projectId)
  if (error) return { error: error.message }
  return { seconds: laneTotalSeconds(data ?? []) }
}

// The current-music columns a finished run or upload writes, in one update. A new piece
// always starts unlooped and unmuted.
async function linkMusic(
  supabase: SupabaseServerClient,
  projectId: string,
  fields: { path: string; durationSec: number; source: 'generated' | 'uploaded' }
): Promise<string | null> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('projects')
    .update({
      music_path: fields.path,
      music_duration_sec: fields.durationSec,
      music_source: fields.source,
      music_generated_at: now,
      music_loop: false,
      music_muted: false,
      updated_at: now,
    })
    .eq('id', projectId)
  return error?.message ?? null
}

// ---------------------------------------------------------------------------------------
// Style prompt: derived once per project, free to the user (usage row, no ledger row).
// ---------------------------------------------------------------------------------------

export type MusicPromptPayload = { kind: 'music_prompt'; style: string }

export type DeriveMusicPromptResult =
  | { ok: true; status: 200; prompt: string | null }
  | { ok: false; status: 402 | 404 | 409 | 500; error: string; code?: string }

/** The film text a style is derived from: the in-film narration, else the shot descriptions. */
async function loadStyleSource(
  supabase: SupabaseServerClient,
  projectId: string
): Promise<{ source: { kind: 'narration' | 'descriptions'; text: string } | null } | { error: string }> {
  const { data, error } = await supabase
    .from('shots')
    .select('id, voice_over, visual_description, order_index, film_order, binned_at')
    .eq('project_id', projectId)
  if (error) return { error: error.message }
  const shots = data ?? []
  const narration = buildScript(shots).text.trim()
  if (narration !== '') return { source: { kind: 'narration', text: narration } }
  const descriptions = laneShots(shots)
    .map((s) => (s.visual_description ?? '').trim())
    .filter((d) => d !== '')
    .join('\n')
  return { source: descriptions === '' ? null : { kind: 'descriptions', text: descriptions } }
}

async function storeStylePrompt(supabase: SupabaseServerClient, projectId: string, style: string): Promise<string | null> {
  // Only into an empty field: a prompt the person typed meanwhile is never overwritten.
  const { error } = await supabase
    .from('projects')
    .update({ music_style_prompt: style, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .is('music_style_prompt', null)
  return error?.message ?? null
}

/**
 * Derives the music style prompt. Called only from the card's first expand while the field
 * is empty - never on render. The claim makes it once per project: a second call (reload,
 * re-expand, another tab) is refused by the claim and makes no call; a failure is never
 * retried automatically, so the field just stays empty for the person to fill.
 */
export async function runMusicPromptDerivation(params: {
  supabase: SupabaseServerClient
  gateway: ClaudeGateway
  projectId: string
  userId: string
}): Promise<DeriveMusicPromptResult> {
  const { supabase, gateway, projectId, userId } = params

  const project = await loadEditableProject(supabase, projectId, userId)
  if ('ok' in project) return project as DeriveMusicPromptResult
  const { data: row } = await supabase.from('projects').select('music_style_prompt').eq('id', projectId).maybeSingle()
  const existing = row?.music_style_prompt?.trim() ?? ''
  if (existing !== '') return { ok: true, status: 200, prompt: existing }

  const loaded = await loadStyleSource(supabase, projectId)
  if ('error' in loaded) return { ok: false, status: 500, error: loaded.error }
  // Nothing to read yet: no claim, so a later expand (once there is a script) can derive.
  if (!loaded.source) return { ok: true, status: 200, prompt: null }

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: STEP, operation: DERIVE, shotId: null, elementId: null },
    retry: false,
    queued: false,
  })
  if (claim.outcome === 'blocked') return { ok: true, status: 200, prompt: null }
  if (claim.outcome === 'error') return { ok: false, status: 500, error: claim.message }
  const generationId = claim.generation.id

  let outcome: DeriveMusicPromptResult = { ok: false, status: 500, error: 'The style prompt was not derived' }
  let usageId: string | null = null
  let measured: UsageBreakdown | null = null
  let stopReason: string | null = null
  let caught: unknown = null
  const model = modelsConfig.musicPrompt.model
  try {
    // RECOVER: a style already paid for is stored, never asked for again.
    const recovered = claim.generation.payload as Partial<MusicPromptPayload> | null
    if (recovered?.kind === 'music_prompt' && typeof recovered.style === 'string') {
      const storeError = await storeStylePrompt(supabase, projectId, recovered.style)
      if (storeError) return (outcome = { ok: false, status: 500, error: storeError })
      return (outcome = { ok: true, status: 200, prompt: recovered.style })
    }

    const dynamicBlock = buildMusicStyleBlock(loaded.source)
    const userMessage = 'Write the music style prompt now.'
    const { estimatedCost, quotedBreakdown } = quoteClaudeCall({
      model,
      estimatedInputTokens: estimateInputTokens({
        texts: [MUSIC_STYLE_PROMPT_V1, dynamicBlock, userMessage],
        tools: [WRITE_MUSIC_STYLE_TOOL],
      }),
      maxTokens: modelsConfig.musicPrompt.maxTokens,
    })
    await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })
    const reserved = await reserveUsage({
      supabase,
      userId,
      projectId,
      generationId,
      shotId: null,
      step: STEP,
      operation: DERIVE,
      provider: 'anthropic',
      model,
      quotedCost: estimatedCost,
      quotedBreakdown,
    })
    usageId = reserved.usageId

    const result = await gateway.createMessage({
      model,
      max_tokens: modelsConfig.musicPrompt.maxTokens,
      system: [
        { type: 'text', text: MUSIC_STYLE_PROMPT_V1 },
        { type: 'text', text: dynamicBlock },
      ],
      tools: [WRITE_MUSIC_STYLE_TOOL],
      tool_choice: { type: 'tool', name: WRITE_MUSIC_STYLE_TOOL.name },
      messages: [{ role: 'user', content: userMessage }],
    })
    measured = result.message.usage
    stopReason = result.stopReason
    console.warn(`[music/prompt] stopReason=${result.stopReason} requestId=${result.requestId}`)

    const block = result.message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === WRITE_MUSIC_STYLE_TOOL.name
    )
    const style = block && stopReason !== 'max_tokens' ? cleanMusicStyle((block.input as { style?: unknown }).style) : null
    if (!style) return (outcome = { ok: false, status: 500, error: 'No usable style prompt came back' })

    // PERSIST before the project is written.
    const { error: persistError } = await persistGenerationPayload(supabase, generationId, {
      kind: 'music_prompt',
      style,
    } satisfies MusicPromptPayload)
    if (persistError) return (outcome = { ok: false, status: 500, error: persistError })

    const storeError = await storeStylePrompt(supabase, projectId, style)
    if (storeError) return (outcome = { ok: false, status: 500, error: storeError })
    return (outcome = { ok: true, status: 200, prompt: style })
  } catch (err) {
    caught = err
    console.error(`[music/prompt] ${generationId} failed`, err)
    return (outcome = {
      ok: false,
      status: err instanceof AllowanceExceededError ? 402 : 500,
      error: errorMessage(err),
    })
  } finally {
    if (usageId) {
      await settleUsage({
        supabase,
        usageId,
        provider: 'anthropic',
        model,
        status: measured !== null && stopReason !== 'max_tokens' ? 'succeeded' : 'failed',
        breakdown: measured,
        stopReason,
        error: outcome.ok ? null : caught,
      })
    }
    const { error: settleError } = await settleGeneration(supabase, generationId, {
      success: outcome.ok,
      error: outcome.ok ? null : outcome.error,
    })
    if (settleError) console.error(`[music/prompt] SETTLE failed for ${generationId}`, settleError)
    // No ledger row: the derivation is free to the user.
  }
}

// ---------------------------------------------------------------------------------------
// Generate: request (validate -> price -> gate -> claim), then the background worker.
// ---------------------------------------------------------------------------------------

export type MusicGeneratePayload = {
  kind: 'generate'
  attemptId: string
  /** The style prompt as it stood when Generate was pressed - later edits don't touch this run. */
  prompt: string
  requestedSec: number
  model: string
  credits: number
  /** The stored file, once the provider's answer is saved - RECOVER relinks it free. */
  path?: string
}

function readGeneratePayload(payload: Json | null): MusicGeneratePayload | null {
  const p = payload as Partial<MusicGeneratePayload> | null
  if (!p || p.kind !== 'generate' || typeof p.attemptId !== 'string' || typeof p.prompt !== 'string') return null
  return p as MusicGeneratePayload
}

export type MusicRequestResult = { ok: true; status: 202; generationId: string; credits: number } | Refusal

export async function runMusicRequest(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  expectedCredits: number
  getBalance: typeof getBalanceType
  ensureSignupGrant: typeof ensureSignupGrantType
  mintAttemptId: typeof mintAttemptIdType
}): Promise<MusicRequestResult> {
  const { supabase, projectId, userId, expectedCredits } = params

  const project = await loadEditableProject(supabase, projectId, userId)
  if ('ok' in project) return project

  const { data: row } = await supabase.from('projects').select('music_style_prompt').eq('id', projectId).maybeSingle()
  const prompt = row?.music_style_prompt?.trim() ?? ''
  if (prompt === '') return { ok: false, status: 422, error: 'Write a style prompt first', code: 'empty' }

  // Sized to the picture now, server-side - never a client figure.
  const picture = await loadPictureSec(supabase, projectId)
  if ('error' in picture) return { ok: false, status: 500, error: picture.error }
  const requestedSec = requestedMusicSec(picture.seconds)

  // The price the button showed must be the price charged.
  const credits = creditsFor({ step: STEP, operation: GENERATE, quantity: requestedSec })
  if (credits !== expectedCredits) {
    return { ok: false, status: 409, error: 'The price changed', code: 'price_changed', credits }
  }

  const peek = await peekGenerationPayload(supabase, { projectId, step: STEP, operation: GENERATE, shotId: null, elementId: null })
  if (peek.error) return { ok: false, status: 500, error: peek.error }
  if (peek.heldByLiveRun) return { ok: false, status: 409, error: 'Music is already being made', code: 'in_flight' }

  const refused = await gate(supabase, userId, credits, params)
  if (refused) return refused

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: STEP, operation: GENERATE, shotId: null, elementId: null },
    retry: true,
    queued: false,
  })
  if (claim.outcome === 'blocked') return { ok: false, status: 409, error: 'Music is already being made', code: 'in_flight' }
  if (claim.outcome === 'error') return { ok: false, status: 500, error: claim.message }

  // A failed attempt for the same prompt and length whose file was already stored resumes
  // under its own attempt id and relinks that file free. Anything else is a fresh attempt.
  const previous = readGeneratePayload(claim.generation.payload)
  const resume =
    previous && previous.path && previous.prompt === prompt && previous.requestedSec === requestedSec ? previous : null
  const payload: MusicGeneratePayload = resume
    ? { ...resume, credits }
    : {
        kind: 'generate',
        attemptId: params.mintAttemptId(),
        prompt,
        requestedSec,
        model: modelsConfig.music.model,
        credits,
      }
  const { error: persistError } = await persistGenerationPayload(supabase, claim.generation.id, payload as unknown as Json)
  if (persistError) {
    await settleGeneration(supabase, claim.generation.id, { success: false, error: persistError })
    return { ok: false, status: 500, error: persistError }
  }
  return { ok: true, status: 202, generationId: claim.generation.id, credits }
}

export type MusicWorkerDeps = {
  supabase: SupabaseServerClient // service role
  gateway: MusicGateway
  recordFixedSpend: typeof recordFixedSpendType
}

export type WorkerOutcome = { ok: true } | { ok: false; error: string }

export async function runMusicWorker(
  deps: MusicWorkerDeps,
  params: { userId: string; projectId: string; generationId: string }
): Promise<WorkerOutcome> {
  const { supabase, gateway } = deps
  const { userId, projectId, generationId } = params
  const startedAt = Date.now()

  const { data: row } = await supabase
    .from('generations')
    .select('*')
    .eq('id', generationId)
    .eq('project_id', projectId)
    .maybeSingle()
  const generation = row as GenerationRow | null
  const payload = generation ? readGeneratePayload(generation.payload) : null
  if (!generation || generation.state !== 'generating' || !payload) return { ok: false, error: 'Claim not found' }

  let outcome: WorkerOutcome = { ok: false, error: 'Unexpected error' }
  try {
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!project) return (outcome = { ok: false, error: 'Project not found' })

    let path = payload.path ?? null
    let audio: Buffer | null = null

    // RECOVER: a file already paid for and stored is relinked, never composed again.
    if (path) {
      audio = await getObject(supabase, path)
      if (!audio) {
        console.error(`[music] stored file for ${generationId} is unreadable; composing again`)
        path = null
      }
    }

    if (!path) {
      const { estimatedCost, quotedBreakdown } = quoteElevenLabsCall({
        model: payload.model,
        audioSeconds: payload.requestedSec,
      })
      await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })
      const { usageId } = await reserveUsage({
        supabase,
        userId,
        projectId,
        generationId,
        shotId: null,
        step: STEP,
        operation: GENERATE,
        provider: 'elevenlabs',
        model: payload.model,
        quotedCost: estimatedCost,
        quotedBreakdown,
      })
      let measured: UsageBreakdown | null = null
      let caught: unknown = null
      try {
        // ONE call, no retry.
        audio = await gateway.compose({
          prompt: payload.prompt,
          lengthMs: Math.round(payload.requestedSec * 1000),
          model: payload.model,
        })
        measured = { input_tokens: 0, output_tokens: 0, audio_seconds: payload.requestedSec }

        // Stored before anything else, never overwriting, so paid audio is never lost.
        const filePath = `${musicDir(userId, projectId)}/${payload.attemptId}.mp3`
        const uploadError = await putObject(supabase, filePath, audio, 'audio/mpeg', { allowExisting: true })
        if (uploadError) throw new Error(`Could not store the music (${uploadError})`)

        // PERSIST the path before the project is linked.
        const { error: persistError } = await persistGenerationPayload(supabase, generationId, {
          ...payload,
          path: filePath,
        } as unknown as Json)
        if (persistError) throw new Error(`Music stored but could not be recorded safely (${persistError})`)
        path = filePath
      } catch (err) {
        caught = err
        throw err
      } finally {
        await settleUsage({
          supabase,
          usageId,
          provider: 'elevenlabs',
          model: payload.model,
          status: measured ? 'succeeded' : 'failed',
          breakdown: measured,
          error: caught,
        })
      }
    }

    const durationSec = await measureDurationSec(audio!, 'audio/mpeg')
    if (durationSec === null) return (outcome = { ok: false, error: 'Could not measure the music' })

    // Past the stale window this claim already reads as failed (and uncharged). Don't
    // contradict that: the file stays recorded for a free resume.
    if (Date.now() - startedAt > MUSIC_STALE_AFTER_MS) {
      return (outcome = { ok: false, error: 'Finished after the stale window' })
    }

    const linkError = await linkMusic(supabase, projectId, { path: path!, durationSec, source: 'generated' })
    if (linkError) return (outcome = { ok: false, error: linkError })
    return (outcome = { ok: true })
  } catch (err) {
    console.error(`[music] ${generationId} failed`, err)
    return (outcome = { ok: false, error: errorMessage(err) })
  } finally {
    // SETTLE. Failure keeps the payload (and any stored path) for RECOVER.
    const { error: settleError } = await settleGeneration(supabase, generationId, {
      success: outcome.ok,
      error: outcome.ok ? null : outcome.error,
    })
    if (settleError) console.error(`[music] SETTLE failed for ${generationId}`, settleError)

    // Ledger: one row, on success only. A failure is never charged.
    if (outcome.ok) {
      try {
        await deps.recordFixedSpend({
          userId,
          step: STEP,
          operation: GENERATE,
          quantity: payload.requestedSec,
          attemptId: payload.attemptId,
          projectId,
          messageId: null,
        })
      } catch (ledgerError) {
        console.error(`[music] ledger write failed for ${generationId}`, ledgerError)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Upload: free. A signed upload URL, then the stored file is measured and linked.
// ---------------------------------------------------------------------------------------

export type MusicUploadUrlResult =
  | { ok: true; attemptId: string; ext: string; path: string; token: string }
  | Refusal

export async function runMusicUploadUrlRequest(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  mime: string
  bytes: number
  mintAttemptId: typeof mintAttemptIdType
}): Promise<MusicUploadUrlResult> {
  const { supabase, projectId, userId, mime, bytes } = params
  const project = await loadEditableProject(supabase, projectId, userId)
  if ('ok' in project) return project

  const ext = MUSIC_UPLOAD_FORMATS[mime]
  if (!ext) return { ok: false, status: 422, error: 'That file type can’t be used as music', code: 'format' }
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MUSIC_UPLOAD_MAX_BYTES) {
    return { ok: false, status: 422, error: 'That file is too large', code: 'too_large' }
  }

  const attemptId = params.mintAttemptId()
  const path = `${musicDir(userId, projectId)}/${attemptId}.${ext}`
  const { data, error } = await supabase.storage.from('artifacts').createSignedUploadUrl(path)
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? 'Could not prepare the upload' }
  return { ok: true, attemptId, ext, path: data.path, token: data.token }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UPLOAD_EXTS = new Set(Object.values(MUSIC_UPLOAD_FORMATS))
const MIME_FOR_EXT: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }

export type MusicUploadResult = { ok: true; status: 200; path: string; durationSec: number } | Refusal

/**
 * Links an uploaded file as the project's music. The duration is read here, server-side,
 * from the stored bytes (music-metadata) - never the browser's figure.
 */
export async function runMusicUploadRequest(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  attemptId: string
  ext: string
}): Promise<MusicUploadResult> {
  const { supabase, projectId, userId, attemptId, ext } = params
  if (!UUID.test(attemptId) || !UPLOAD_EXTS.has(ext)) return { ok: false, status: 400, error: 'Invalid upload' }

  const project = await loadEditableProject(supabase, projectId, userId)
  if ('ok' in project) return project

  const path = `${musicDir(userId, projectId)}/${attemptId}.${ext}`
  const audio = await getObject(supabase, path)
  if (!audio) return { ok: false, status: 404, error: 'The upload was not found', code: 'missing' }
  if (audio.length > MUSIC_UPLOAD_MAX_BYTES) return { ok: false, status: 422, error: 'That file is too large', code: 'too_large' }
  const durationSec = await measureDurationSec(audio, MIME_FOR_EXT[ext])
  if (durationSec === null) return { ok: false, status: 422, error: 'That file couldn’t be read as audio', code: 'unreadable' }
  if (durationSec > MUSIC_UPLOAD_MAX_SEC) return { ok: false, status: 422, error: 'That track is too long', code: 'too_long' }

  const linkError = await linkMusic(supabase, projectId, { path, durationSec, source: 'uploaded' })
  if (linkError) return { ok: false, status: 500, error: linkError }
  return { ok: true, status: 200, path, durationSec }
}
