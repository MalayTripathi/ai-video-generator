import { createHash, randomBytes } from 'node:crypto'
import type { createClient } from '@/lib/supabase/server'
import type { Json, Tables } from '@/lib/database.types'
// Type-only, like every paid route's logic.ts: the route injects the real functions, so a
// plain-Node test can pass fakes and this file adds no service-role import.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '@/lib/credits/signup-grant'
import type { mintAttemptId as mintAttemptIdType, recordFixedSpend as recordFixedSpendType } from '@/lib/credits/ledger'
import type { VoiceoverGateway } from '@/lib/voiceover/gateway'
import { creditsFor } from '@/lib/config/credits'
import { stepIndex } from '@/lib/config/pipeline'
import { findVoice, modelsConfig } from '@/lib/config/models'
import { ELEVENLABS_ALIGNMENT_MODEL, type UsageBreakdown } from '@/lib/config/pricing'
import {
  VOICEOVER_ALIGN_STALE_AFTER_MS,
  VOICEOVER_CHUNK_MAX_CHARS,
  VOICEOVER_MAX_SCRIPT_CHARS,
  VOICEOVER_STALE_AFTER_MS,
  VOICEOVER_UPLOAD_FORMATS,
  VOICEOVER_UPLOAD_MAX_BYTES,
  VOICEOVER_UPLOAD_MAX_SEC,
} from '@/lib/config/storyboard'
import { claimGeneration, peekGenerationPayload, persistGenerationPayload, settleGeneration } from '@/lib/generations/claim'
import { assertWithinAllowance, reserveUsage, settleUsage } from '@/lib/usage'
import { quoteElevenLabsCall } from '@/lib/usage/quote'
import { liveVoiceoverCommittedCredits } from '@/lib/voiceover/committed'
import { concatMp3, measureDurationSec } from '@/lib/voiceover/audio'
import {
  alignmentFromForced,
  buildScript,
  buildSpans,
  chunkScript,
  mergeAlignments,
  readAlignment,
  ShotTooLongError,
  type CharacterAlignment,
  type VoiceoverScript,
  type VoiceoverSpan,
} from '@/lib/storyboard/voiceover'
import { countLiveImageClaims } from '../images/logic'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>
type GenerationRow = Tables<'generations'>

const STEP = 'storyboard' as const
const GENERATE = 'voiceover' as const
const ALIGN = 'align_voiceover' as const

// ---------------------------------------------------------------------------------------
// Shared: project, script, the spend gate
// ---------------------------------------------------------------------------------------

type VoiceoverProject = { id: string; language: string | null }

type Refusal =
  | { ok: false; status: 400 | 404 | 409 | 422 | 500; error: string; code?: string; credits?: number; shotId?: string }
  | { ok: false; status: 402; error: string; requiredCredits: number; balanceCredits: number }

async function loadEditableProject(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string
): Promise<VoiceoverProject | Refusal> {
  const { data: project } = await supabase
    .from('projects')
    .select('id, language, furthest_step')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!project) return { ok: false, status: 404, error: 'Project not found' }
  if (project.furthest_step >= stepIndex('video_prompts')) {
    return { ok: false, status: 409, error: 'The storyboard is locked', code: 'locked' }
  }
  return { id: project.id, language: project.language }
}

/** The script as it stands now: every in-film shot's narration, in film order. */
export async function loadScript(
  supabase: SupabaseServerClient,
  projectId: string
): Promise<{ script: VoiceoverScript } | { error: string }> {
  const { data, error } = await supabase
    .from('shots')
    .select('id, voice_over, order_index, film_order, binned_at')
    .eq('project_id', projectId)
  if (error) return { error: error.message }
  return { script: buildScript(data ?? []) }
}

export function scriptHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * THE GATE - before any claim. Effective balance = ledger balance minus everything this
 * user has committed to in-flight storyboard work (images and voiceovers). A 402 here
 * writes nothing at all.
 */
async function gate(
  supabase: SupabaseServerClient,
  userId: string,
  price: number,
  deps: { getBalance: typeof getBalanceType; ensureSignupGrant: typeof ensureSignupGrantType }
): Promise<Refusal | null> {
  await deps.ensureSignupGrant(userId)
  const balance = await deps.getBalance(userId)
  const imagePrice = creditsFor({ step: STEP, operation: 'generate_image', quantity: 1 })
  const committed =
    (await countLiveImageClaims(supabase, userId)) * imagePrice + (await liveVoiceoverCommittedCredits(supabase, userId))
  const effective = Math.max(0, balance - committed)
  if (effective < price) {
    return {
      ok: false,
      status: 402,
      error: `Not enough credits: this costs ${price}, available balance is ${effective}.`,
      requiredCredits: price,
      balanceCredits: effective,
    }
  }
  return null
}

/** One voiceover in flight per project, whichever way it's being made. */
async function inFlightRefusal(supabase: SupabaseServerClient, projectId: string): Promise<Refusal | null> {
  for (const operation of [GENERATE, ALIGN] as const) {
    const peek = await peekGenerationPayload(supabase, { projectId, step: STEP, operation, shotId: null, elementId: null })
    if (peek.error) return { ok: false, status: 500, error: peek.error }
    if (peek.heldByLiveRun) return { ok: false, status: 409, error: 'A voiceover is already being made', code: 'in_flight' }
  }
  return null
}

function claimRefusal(claim: Awaited<ReturnType<typeof claimGeneration>>): Refusal | null {
  if (claim.outcome === 'claimed') return null
  if (claim.outcome === 'blocked') return { ok: false, status: 409, error: 'A voiceover is already being made', code: 'in_flight' }
  return { ok: false, status: 500, error: claim.message }
}

export function voiceoverDir(userId: string, projectId: string): string {
  return `${userId}/${projectId}/voiceover`
}

// The current-voiceover columns a finished read writes, in one update.
async function linkVoiceover(
  supabase: SupabaseServerClient,
  projectId: string,
  fields: {
    audioPath: string
    alignmentPath: string
    voiceId: string | null
    languageCode: string | null
    ttsModel: string | null
    durationSec: number
    source: 'generated' | 'uploaded'
    spans: VoiceoverSpan[]
  }
): Promise<string | null> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('projects')
    .update({
      audio_path: fields.audioPath,
      voiceover_alignment_path: fields.alignmentPath,
      voice_id: fields.voiceId,
      language_code: fields.languageCode,
      tts_model: fields.ttsModel,
      total_duration_sec: fields.durationSec,
      voiceover_source: fields.source,
      voiceover_generated_at: now,
      voiceover_muted: false,
      voiceover_spans: fields.spans as unknown as Json,
      updated_at: now,
    })
    .eq('id', projectId)
  return error?.message ?? null
}

// Storage writes never overwrite. A retry re-writing an object an earlier run already
// stored (same attempt, same bytes) is detected by the storage error's status code.
async function putObject(
  supabase: SupabaseServerClient,
  path: string,
  body: Buffer | string,
  contentType: string,
  { allowExisting = false }: { allowExisting?: boolean } = {}
): Promise<string | null> {
  const { error } = await supabase.storage.from('artifacts').upload(path, body, { contentType, upsert: false })
  if (!error) return null
  if (allowExisting && (error as { statusCode?: string }).statusCode === '409') return null
  return error.message
}

async function getObject(supabase: SupabaseServerClient, path: string): Promise<Buffer | null> {
  const { data, error } = await supabase.storage.from('artifacts').download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error'
}

// ---------------------------------------------------------------------------------------
// Generate: request (validate -> price -> gate -> claim), then the background worker.
// ---------------------------------------------------------------------------------------

type GeneratePart = { path: string; alignmentPath: string; durationSec: number }

export type GeneratePayload = {
  kind: 'generate'
  attemptId: string
  voiceId: string
  languageCode: string | null
  model: string
  scriptHash: string
  chars: number
  credits: number
  parts: GeneratePart[]
}

function readGeneratePayload(payload: Json | null): GeneratePayload | null {
  const p = payload as Partial<GeneratePayload> | null
  if (!p || p.kind !== 'generate' || typeof p.attemptId !== 'string' || !Array.isArray(p.parts)) return null
  return p as GeneratePayload
}

export type GenerateRequestResult = { ok: true; status: 202; generationId: string; credits: number } | Refusal

export async function runVoiceoverRequest(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  voiceId: string
  expectedCredits: number
  getBalance: typeof getBalanceType
  ensureSignupGrant: typeof ensureSignupGrantType
  mintAttemptId: typeof mintAttemptIdType
}): Promise<GenerateRequestResult> {
  const { supabase, projectId, userId, voiceId, expectedCredits } = params

  const project = await loadEditableProject(supabase, projectId, userId)
  if ('ok' in project) return project

  const voice = findVoice(project.language, voiceId)
  if (!voice) return { ok: false, status: 400, error: 'That voice is not offered for this project’s language' }

  const loaded = await loadScript(supabase, projectId)
  if ('error' in loaded) return { ok: false, status: 500, error: loaded.error }
  const { script } = loaded
  if (script.text.trim() === '') return { ok: false, status: 422, error: 'There is no narration to read', code: 'empty' }
  if (script.text.length > VOICEOVER_MAX_SCRIPT_CHARS) {
    return { ok: false, status: 422, error: 'The narration is too long to read in one voiceover', code: 'too_long' }
  }
  try {
    chunkScript(script, VOICEOVER_CHUNK_MAX_CHARS)
  } catch (err) {
    if (err instanceof ShotTooLongError) {
      return { ok: false, status: 422, error: err.message, code: 'shot_too_long', shotId: err.shotId }
    }
    throw err
  }

  // The price the button showed must be the price charged - a mismatch means the script
  // changed underneath it, and the person confirms again rather than paying a surprise.
  const credits = creditsFor({ step: STEP, operation: GENERATE, quantity: script.text.length })
  if (credits !== expectedCredits) {
    return { ok: false, status: 409, error: 'The price changed', code: 'price_changed', credits }
  }

  const busy = await inFlightRefusal(supabase, projectId)
  if (busy) return busy

  const refused = await gate(supabase, userId, credits, params)
  if (refused) return refused

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: STEP, operation: GENERATE, shotId: null, elementId: null },
    retry: true,
    queued: false,
  })
  const claimError = claimRefusal(claim)
  if (claimError || claim.outcome !== 'claimed') return claimError!

  // A failed attempt for the same voice and script keeps its paid parts: resume it under
  // its own attempt id. Anything else starts a fresh attempt (older files stay in storage).
  const hash = scriptHash(script.text)
  const previous = readGeneratePayload(claim.generation.payload)
  const resume = previous && previous.voiceId === voice.id && previous.scriptHash === hash ? previous : null
  const payload: GeneratePayload = {
    kind: 'generate',
    attemptId: resume?.attemptId ?? params.mintAttemptId(),
    voiceId: voice.id,
    languageCode: project.language,
    model: modelsConfig.voiceover.model,
    scriptHash: hash,
    chars: script.text.length,
    credits,
    parts: resume?.parts ?? [],
  }
  const { error: persistError } = await persistGenerationPayload(supabase, claim.generation.id, payload as unknown as Json)
  if (persistError) {
    await settleGeneration(supabase, claim.generation.id, { success: false, error: persistError })
    return { ok: false, status: 500, error: persistError }
  }

  return { ok: true, status: 202, generationId: claim.generation.id, credits }
}

export type VoiceoverWorkerDeps = {
  supabase: SupabaseServerClient // service role
  gateway: VoiceoverGateway
  recordFixedSpend: typeof recordFixedSpendType
}

export type WorkerOutcome = { ok: true } | { ok: false; error: string }

export async function runVoiceoverWorker(
  deps: VoiceoverWorkerDeps,
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

    // The script is re-read, never trusted from the request: if it changed in between, the
    // read would describe the wrong shots.
    const loaded = await loadScript(supabase, projectId)
    if ('error' in loaded) return (outcome = { ok: false, error: loaded.error })
    const { script } = loaded
    if (scriptHash(script.text) !== payload.scriptHash) {
      return (outcome = { ok: false, error: 'The narration changed before the read started' })
    }
    const chunks = chunkScript(script, VOICEOVER_CHUNK_MAX_CHARS)
    const dir = voiceoverDir(userId, projectId)

    const audios: (Buffer | null)[] = chunks.map(() => null)
    const alignments: (CharacterAlignment | null)[] = chunks.map(() => null)
    const parts = [...payload.parts]

    for (let k = 0; k < chunks.length; k++) {
      // RECOVER: a part already paid for and stored is never read again.
      const stored = parts[k]
      if (stored) {
        const audio = await getObject(supabase, stored.path)
        const alignmentJson = await getObject(supabase, stored.alignmentPath)
        if (audio && alignmentJson) {
          audios[k] = audio
          alignments[k] = JSON.parse(alignmentJson.toString('utf8')) as CharacterAlignment
          continue
        }
        console.error(`[voiceover] stored part ${k + 1} of ${generationId} is unreadable; reading it again`)
        parts.length = k
      }

      const chunk = chunks[k]
      const { estimatedCost, quotedBreakdown } = quoteElevenLabsCall({ model: payload.model, characters: chunk.text.length })
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
        // ONE call per part, no retry.
        const result = await gateway.synthesize({
          text: chunk.text,
          voiceId: payload.voiceId,
          model: payload.model,
          languageCode: payload.languageCode,
        })
        measured = { input_tokens: 0, output_tokens: 0, characters: chunk.text.length }

        // Stored before it's checked, so paid audio is never lost to a later failure.
        const nonce = randomBytes(3).toString('hex')
        const partPath = `${dir}/${payload.attemptId}.part${k + 1}.${nonce}.mp3`
        const uploadError = await putObject(supabase, partPath, result.audio, 'audio/mpeg')
        if (uploadError) throw new Error(`Could not store the read (${uploadError})`)

        const alignment = readAlignment(result.timestamps, chunk.text)
        const durationSec = await measureDurationSec(result.audio, 'audio/mpeg')
        if (durationSec === null) throw new Error('Could not measure the read')
        const alignmentPath = `${dir}/${payload.attemptId}.part${k + 1}.${nonce}.alignment.json`
        const alignmentError = await putObject(supabase, alignmentPath, JSON.stringify(alignment), 'application/json')
        if (alignmentError) throw new Error(`Could not store the alignment (${alignmentError})`)

        // PERSIST each part as it lands, so a failure later in the chain resumes here free.
        parts[k] = { path: partPath, alignmentPath, durationSec }
        const { error: persistError } = await persistGenerationPayload(supabase, generationId, {
          ...payload,
          parts,
        } as unknown as Json)
        if (persistError) throw new Error(`Read stored but could not be recorded safely (${persistError})`)

        audios[k] = result.audio
        alignments[k] = alignment
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

    const durations = parts.map((p) => p.durationSec)
    const merged = mergeAlignments(script.text, chunks, alignments as CharacterAlignment[], durations)
    const spans = buildSpans(script, merged)
    const totalSec = durations.reduce((a, b) => a + b, 0)

    const audioPath = `${dir}/${payload.attemptId}.mp3`
    const alignmentPath = `${dir}/${payload.attemptId}.alignment.json`
    const audioError = await putObject(supabase, audioPath, concatMp3(audios as Buffer[]), 'audio/mpeg', {
      allowExisting: true,
    })
    if (audioError) return (outcome = { ok: false, error: `Could not store the voiceover (${audioError})` })
    const alignmentError = await putObject(
      supabase,
      alignmentPath,
      JSON.stringify({ text: script.text, alignment: merged, spans }),
      'application/json',
      { allowExisting: true }
    )
    if (alignmentError) return (outcome = { ok: false, error: `Could not store the alignment (${alignmentError})` })

    // Past the stale window this claim already reads as failed (and uncharged) to the
    // person. Don't contradict that: the parts stay recorded for a free resume.
    if (Date.now() - startedAt > VOICEOVER_STALE_AFTER_MS) {
      return (outcome = { ok: false, error: 'Finished after the stale window' })
    }

    const linkError = await linkVoiceover(supabase, projectId, {
      audioPath,
      alignmentPath,
      voiceId: payload.voiceId,
      languageCode: payload.languageCode,
      ttsModel: payload.model,
      durationSec: totalSec,
      source: 'generated',
      spans,
    })
    if (linkError) return (outcome = { ok: false, error: linkError })
    return (outcome = { ok: true })
  } catch (err) {
    console.error(`[voiceover] ${generationId} failed`, err)
    return (outcome = { ok: false, error: errorMessage(err) })
  } finally {
    // SETTLE. Failure keeps the payload (and its paid parts) for RECOVER.
    const { error: settleError } = await settleGeneration(supabase, generationId, {
      success: outcome.ok,
      error: outcome.ok ? null : outcome.error,
    })
    if (settleError) console.error(`[voiceover] SETTLE failed for ${generationId}`, settleError)

    // Ledger: one row, on full success only. A failure is never charged.
    if (outcome.ok) {
      try {
        await deps.recordFixedSpend({
          userId,
          step: STEP,
          operation: GENERATE,
          quantity: payload.chars,
          attemptId: payload.attemptId,
          projectId,
          messageId: null,
        })
      } catch (ledgerError) {
        console.error(`[voiceover] ledger write failed for ${generationId}`, ledgerError)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Upload: a signed upload URL, then alignment (request -> gate -> claim -> worker).
// ---------------------------------------------------------------------------------------

export type UploadUrlResult =
  | { ok: true; attemptId: string; ext: string; path: string; token: string }
  | Refusal

export async function runUploadUrlRequest(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  mime: string
  bytes: number
  mintAttemptId: typeof mintAttemptIdType
}): Promise<UploadUrlResult> {
  const { supabase, projectId, userId, mime, bytes } = params
  const project = await loadEditableProject(supabase, projectId, userId)
  if ('ok' in project) return project

  const ext = VOICEOVER_UPLOAD_FORMATS[mime]
  if (!ext) return { ok: false, status: 422, error: 'That file type can’t be used as a voiceover', code: 'format' }
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > VOICEOVER_UPLOAD_MAX_BYTES) {
    return { ok: false, status: 422, error: 'That file is too large', code: 'too_large' }
  }

  const attemptId = params.mintAttemptId()
  const path = `${voiceoverDir(userId, projectId)}/${attemptId}.${ext}`
  const { data, error } = await supabase.storage.from('artifacts').createSignedUploadUrl(path)
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? 'Could not prepare the upload' }
  return { ok: true, attemptId, ext, path: data.path, token: data.token }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UPLOAD_EXTS = new Set(Object.values(VOICEOVER_UPLOAD_FORMATS))
const MIME_FOR_EXT: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }

export type AlignPayload = {
  kind: 'align'
  attemptId: string
  uploadPath: string
  mime: string
  durationSec: number
  scriptHash: string
  credits: number
  alignmentPath?: string
  spans?: VoiceoverSpan[]
}

function readAlignPayload(payload: Json | null): AlignPayload | null {
  const p = payload as Partial<AlignPayload> | null
  if (!p || p.kind !== 'align' || typeof p.attemptId !== 'string' || typeof p.uploadPath !== 'string') return null
  return p as AlignPayload
}

export type AlignRequestResult =
  | { ok: true; status: 202; generationId: string; credits: number; audio: Buffer }
  | Refusal

export async function runAlignRequest(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  attemptId: string
  ext: string
  expectedCredits: number
  getBalance: typeof getBalanceType
  ensureSignupGrant: typeof ensureSignupGrantType
}): Promise<AlignRequestResult> {
  const { supabase, projectId, userId, attemptId, ext, expectedCredits } = params
  if (!UUID.test(attemptId) || !UPLOAD_EXTS.has(ext)) return { ok: false, status: 400, error: 'Invalid upload' }

  const project = await loadEditableProject(supabase, projectId, userId)
  if ('ok' in project) return project

  const uploadPath = `${voiceoverDir(userId, projectId)}/${attemptId}.${ext}`
  const audio = await getObject(supabase, uploadPath)
  if (!audio) return { ok: false, status: 404, error: 'The upload was not found', code: 'missing' }
  if (audio.length > VOICEOVER_UPLOAD_MAX_BYTES) return { ok: false, status: 422, error: 'That file is too large', code: 'too_large' }
  const mime = MIME_FOR_EXT[ext]
  const durationSec = await measureDurationSec(audio, mime)
  if (durationSec === null) return { ok: false, status: 422, error: 'That file couldn’t be read as audio', code: 'unreadable' }
  if (durationSec > VOICEOVER_UPLOAD_MAX_SEC) {
    return { ok: false, status: 422, error: 'That recording is too long', code: 'too_long' }
  }

  const loaded = await loadScript(supabase, projectId)
  if ('error' in loaded) return { ok: false, status: 500, error: loaded.error }
  if (loaded.script.text.trim() === '') return { ok: false, status: 422, error: 'There is no narration to align to', code: 'empty' }

  // Priced from the duration measured here, never from the browser's figure.
  const credits = creditsFor({ step: STEP, operation: ALIGN, quantity: durationSec })
  if (credits !== expectedCredits) {
    return { ok: false, status: 409, error: 'The price changed', code: 'price_changed', credits }
  }

  const busy = await inFlightRefusal(supabase, projectId)
  if (busy) return busy

  const refused = await gate(supabase, userId, credits, params)
  if (refused) return refused

  const claim = await claimGeneration({
    supabase,
    identity: { projectId, step: STEP, operation: ALIGN, shotId: null, elementId: null },
    retry: true,
    queued: false,
  })
  const claimError = claimRefusal(claim)
  if (claimError || claim.outcome !== 'claimed') return claimError!

  const payload: AlignPayload = {
    kind: 'align',
    attemptId,
    uploadPath,
    mime,
    durationSec,
    scriptHash: scriptHash(loaded.script.text),
    credits,
  }
  const { error: persistError } = await persistGenerationPayload(supabase, claim.generation.id, payload as unknown as Json)
  if (persistError) {
    await settleGeneration(supabase, claim.generation.id, { success: false, error: persistError })
    return { ok: false, status: 500, error: persistError }
  }
  return { ok: true, status: 202, generationId: claim.generation.id, credits, audio }
}

export async function runAlignWorker(
  deps: VoiceoverWorkerDeps,
  params: { userId: string; projectId: string; generationId: string; audio?: Buffer }
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
  const payload = generation ? readAlignPayload(generation.payload) : null
  if (!generation || generation.state !== 'generating' || !payload) return { ok: false, error: 'Claim not found' }

  let outcome: WorkerOutcome = { ok: false, error: 'Unexpected error' }
  try {
    const { data: project } = await supabase
      .from('projects')
      .select('id, language')
      .eq('id', projectId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!project) return (outcome = { ok: false, error: 'Project not found' })

    const loaded = await loadScript(supabase, projectId)
    if ('error' in loaded) return (outcome = { ok: false, error: loaded.error })
    const { script } = loaded
    if (scriptHash(script.text) !== payload.scriptHash) {
      return (outcome = { ok: false, error: 'The narration changed before the alignment started' })
    }

    let spans = payload.spans ?? null
    let alignmentPath = payload.alignmentPath ?? null

    // RECOVER: an alignment already paid for and stored is relinked, never re-called.
    if (!spans || !alignmentPath) {
      const audio = params.audio ?? (await getObject(supabase, payload.uploadPath))
      if (!audio) return (outcome = { ok: false, error: 'The upload was not found' })

      const { estimatedCost, quotedBreakdown } = quoteElevenLabsCall({
        model: ELEVENLABS_ALIGNMENT_MODEL,
        audioSeconds: payload.durationSec,
      })
      await assertWithinAllowance({ supabase, userId, quotedCost: estimatedCost })
      const { usageId } = await reserveUsage({
        supabase,
        userId,
        projectId,
        generationId,
        shotId: null,
        step: STEP,
        operation: ALIGN,
        provider: 'elevenlabs',
        model: ELEVENLABS_ALIGNMENT_MODEL,
        quotedCost: estimatedCost,
        quotedBreakdown,
      })
      let measured: UsageBreakdown | null = null
      let caught: unknown = null
      let characters: Awaited<ReturnType<VoiceoverGateway['align']>>['characters']
      try {
        const result = await gateway.align({
          audio,
          mime: payload.mime,
          fileName: payload.uploadPath.split('/').pop() ?? 'voiceover',
          text: script.text,
        })
        measured = { input_tokens: 0, output_tokens: 0, audio_seconds: payload.durationSec }
        characters = result.characters
      } catch (err) {
        caught = err
        throw err
      } finally {
        await settleUsage({
          supabase,
          usageId,
          provider: 'elevenlabs',
          model: ELEVENLABS_ALIGNMENT_MODEL,
          status: measured ? 'succeeded' : 'failed',
          breakdown: measured,
          error: caught,
        })
      }

      const alignment = alignmentFromForced(script.text, characters)
      spans = buildSpans(script, alignment)
      alignmentPath = `${voiceoverDir(userId, projectId)}/${payload.attemptId}.alignment.json`
      const alignmentError = await putObject(
        supabase,
        alignmentPath,
        JSON.stringify({ text: script.text, alignment, spans }),
        'application/json',
        { allowExisting: true }
      )
      if (alignmentError) return (outcome = { ok: false, error: `Could not store the alignment (${alignmentError})` })

      // PERSIST before the project is linked.
      const { error: persistError } = await persistGenerationPayload(supabase, generationId, {
        ...payload,
        alignmentPath,
        spans,
      } as unknown as Json)
      if (persistError) return (outcome = { ok: false, error: `Aligned but could not be recorded safely (${persistError})` })
    }

    if (Date.now() - startedAt > VOICEOVER_ALIGN_STALE_AFTER_MS) {
      return (outcome = { ok: false, error: 'Finished after the stale window' })
    }

    const linkError = await linkVoiceover(supabase, projectId, {
      audioPath: payload.uploadPath,
      alignmentPath,
      voiceId: null,
      languageCode: project.language,
      ttsModel: null,
      durationSec: payload.durationSec,
      source: 'uploaded',
      spans,
    })
    if (linkError) return (outcome = { ok: false, error: linkError })
    return (outcome = { ok: true })
  } catch (err) {
    console.error(`[voiceover/align] ${generationId} failed`, err)
    return (outcome = { ok: false, error: errorMessage(err) })
  } finally {
    const { error: settleError } = await settleGeneration(supabase, generationId, {
      success: outcome.ok,
      error: outcome.ok ? null : outcome.error,
    })
    if (settleError) console.error(`[voiceover/align] SETTLE failed for ${generationId}`, settleError)

    if (outcome.ok) {
      try {
        await deps.recordFixedSpend({
          userId,
          step: STEP,
          operation: ALIGN,
          quantity: payload.durationSec,
          attemptId: payload.attemptId,
          projectId,
          messageId: null,
        })
      } catch (ledgerError) {
        console.error(`[voiceover/align] ledger write failed for ${generationId}`, ledgerError)
      }
    }
  }
}
