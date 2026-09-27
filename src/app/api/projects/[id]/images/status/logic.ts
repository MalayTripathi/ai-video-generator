import type { createClient } from '@/lib/supabase/server'
// Type-only: the route injects the real function, so a plain-Node test can pass a fake.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import { creditsFor } from '@/lib/config/credits'
import { STATUS_POLL_INTERVAL_MS, STORYBOARD_SIGNED_URL_EXPIRES_S } from '@/lib/config/storyboard'
import { deriveImageState, type ImageState } from '@/lib/storyboard/image-state'
import { countLiveImageClaims, storyboardThumbPath } from '../logic'
import { isLiveClaim } from '@/lib/generations/claim'
import { liveVoiceoverCommittedCredits } from '@/lib/voiceover/committed'
import { type WordBoundary } from '@/lib/storyboard/motion'
import { type VoiceoverSpan } from '@/lib/storyboard/voiceover'
import { currentRead } from '@/lib/export/film-input'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export type ShotImageStatus = {
  shotId: string
  state: ImageState
  imagePath: string | null
  /** Signed URL of the full image, or null when there is none (or signing failed). */
  imageUrl: string | null
  /** Signed URL of the lane thumbnail; null when it doesn't exist - the page falls back to imageUrl. */
  thumbUrl: string | null
  startedAt: string | null
  queuedAt: string | null
  /** When the current image was drawn: the settled claim's updated_at, when that claim left an image. */
  drawnAt: string | null
}

/** The project's current voiceover, when there is one. */
export type CurrentVoiceover = {
  /** The stored file (projects.audio_path) - what the film timeline names; audioUrl is its signed URL. */
  audioPath: string
  audioUrl: string | null
  voiceId: string | null
  languageCode: string | null
  durationSec: number
  source: 'generated' | 'uploaded'
  generatedAt: string
  muted: boolean
  spans: VoiceoverSpan[]
  /** Spoken-word boundaries (projects.voiceover_words) for the forced-cut rule; null if absent. */
  words: WordBoundary[] | null
}

export type VoiceoverStatus = {
  /** none: nothing yet; generating: a read or alignment is in flight; failed: the latest attempt didn't land. */
  state: 'none' | 'generating' | 'failed' | 'present'
  /** Which way the in-flight or failed attempt was being made. */
  mode: 'generate' | 'upload' | null
  startedAt: string | null
  failedAt: string | null
  /** The in-flight or failed generate attempt's voice. */
  attemptVoiceId: string | null
  /** The in-flight generate attempt's script length, for the "reading N seconds" line. */
  attemptChars: number | null
  /** The in-flight or failed upload's measured length. */
  attemptDurationSec: number | null
  /** A failed upload whose file is still stored - Try again aligns it without re-uploading. */
  retryUpload: { attemptId: string; ext: string; durationSec: number } | null
  current: CurrentVoiceover | null
}

export type ImageStatusData = {
  shots: ShotImageStatus[]
  voiceover: VoiceoverStatus
  pollIntervalMs: number
  /** When the signed URLs above expire - the page re-signs before this. */
  expiresAt: string
  /** Credits available: ledger balance minus live image and voiceover claims. Null if unreadable. */
  balanceCredits: number | null
}

export type ImageStatusResult =
  | { ok: true; data: ImageStatusData }
  | { ok: false; status: 404 | 500; error: string }

/**
 * Per-shot storyboard image state for one project, cheap enough to poll: two narrow
 * selects, a pure derivation, ONE batched signing call for every full image and thumbnail,
 * and the balance the case-2 banner needs. imagePath is present for every state, so a
 * failed regenerate still shows the image it was replacing.
 */
export async function loadImageStatuses(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  getBalance: typeof getBalanceType
}): Promise<ImageStatusResult> {
  const { supabase, projectId, userId, getBalance } = params

  const { data: project } = await supabase
    .from('projects')
    .select(
      'id, audio_path, voice_id, language_code, total_duration_sec, voiceover_source, voiceover_generated_at, voiceover_muted, voiceover_spans, voiceover_words'
    )
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!project) return { ok: false, status: 404, error: 'Project not found' }

  const [shotsResult, claimsResult, voiceoverClaimsResult] = await Promise.all([
    supabase
      .from('shots')
      .select('id, image_path, image_stale')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true }),
    supabase
      .from('generations')
      .select('shot_id, state, started_at, queued_at, updated_at')
      .eq('project_id', projectId)
      .eq('step', 'storyboard')
      .eq('operation', 'generate_image'),
    supabase
      .from('generations')
      .select('operation, state, started_at, queued_at, updated_at, payload')
      .eq('project_id', projectId)
      .eq('step', 'storyboard')
      .in('operation', ['voiceover', 'align_voiceover']),
  ])
  if (shotsResult.error) return { ok: false, status: 500, error: shotsResult.error.message }
  if (claimsResult.error) return { ok: false, status: 500, error: claimsResult.error.message }
  if (voiceoverClaimsResult.error) return { ok: false, status: 500, error: voiceoverClaimsResult.error.message }
  const shotRows = shotsResult.data ?? []

  const paths: string[] = []
  if (project.audio_path) paths.push(project.audio_path)
  for (const shot of shotRows) {
    if (shot.image_path) paths.push(shot.image_path, storyboardThumbPath(shot.image_path))
  }
  const urlByPath = new Map<string, string>()
  if (paths.length > 0) {
    const { data: signed, error: signError } = await supabase.storage
      .from('artifacts')
      .createSignedUrls(paths, STORYBOARD_SIGNED_URL_EXPIRES_S)
    if (signError) {
      console.error(`[images/status] batch signing failed for project ${projectId}:`, signError.message)
    } else {
      // A thumbnail that was never written comes back as a per-entry error - that's the
      // expected fallback case, not a failure worth logging.
      for (const entry of signed ?? []) {
        if (!entry.error && entry.signedUrl && entry.path) urlByPath.set(entry.path, entry.signedUrl)
      }
    }
  }

  const claimByShot = new Map((claimsResult.data ?? []).map((row) => [row.shot_id, row]))
  const now = Date.now()
  const shots: ShotImageStatus[] = shotRows.map((shot) => {
    const claim = claimByShot.get(shot.id) ?? null
    const settled = claim !== null && (claim.state === 'succeeded' || claim.state === 'failed')
    return {
      shotId: shot.id,
      state: deriveImageState(shot, claim, now),
      imagePath: shot.image_path,
      imageUrl: shot.image_path ? (urlByPath.get(shot.image_path) ?? null) : null,
      thumbUrl: shot.image_path ? (urlByPath.get(storyboardThumbPath(shot.image_path)) ?? null) : null,
      startedAt: claim?.started_at ?? null,
      queuedAt: claim?.queued_at ?? null,
      drawnAt: settled && shot.image_path ? claim.updated_at : null,
    }
  })

  const voiceover = deriveVoiceoverStatus(
    project,
    voiceoverClaimsResult.data ?? [],
    project.audio_path ? (urlByPath.get(project.audio_path) ?? null) : null,
    now
  )

  let balanceCredits: number | null = null
  try {
    const price = creditsFor({ step: 'storyboard', operation: 'generate_image', quantity: 1 })
    const committed =
      (await countLiveImageClaims(supabase, userId)) * price + (await liveVoiceoverCommittedCredits(supabase, userId))
    balanceCredits = Math.max(0, (await getBalance(userId)) - committed)
  } catch (err) {
    console.error(`[images/status] balance unreadable for project ${projectId}:`, err)
  }

  return {
    ok: true,
    data: {
      shots,
      voiceover,
      pollIntervalMs: STATUS_POLL_INTERVAL_MS,
      expiresAt: new Date(now + STORYBOARD_SIGNED_URL_EXPIRES_S * 1000).toISOString(),
      balanceCredits,
    },
  }
}

type VoiceoverProjectRow = {
  audio_path: string | null
  voice_id: string | null
  language_code: string | null
  total_duration_sec: number | null
  voiceover_source: string | null
  voiceover_generated_at: string | null
  voiceover_muted: boolean
  voiceover_spans: unknown
  voiceover_words?: unknown
}

type VoiceoverClaimRow = {
  operation: string
  state: string
  started_at: string | null
  queued_at: string | null
  updated_at: string
  payload: unknown
}

/**
 * The voiceover lane's state, from the project's current-voiceover columns plus its two
 * claim rows (generate and align). In flight wins; then a failed latest attempt; then the
 * read itself.
 */
export function deriveVoiceoverStatus(
  project: VoiceoverProjectRow,
  claims: VoiceoverClaimRow[],
  audioUrl: string | null,
  now: number
): VoiceoverStatus {
  // The same rule the film (and so export) reads the current read by.
  const read = currentRead(project)
  const current: CurrentVoiceover | null =
    read && project.voiceover_generated_at
      ? {
          ...read,
          audioUrl,
          voiceId: project.voice_id,
          languageCode: project.language_code,
          source: project.voiceover_source === 'uploaded' ? 'uploaded' : 'generated',
          generatedAt: project.voiceover_generated_at,
        }
      : null

  const base: VoiceoverStatus = {
    state: current ? 'present' : 'none',
    mode: null,
    startedAt: null,
    failedAt: null,
    attemptVoiceId: null,
    attemptChars: null,
    attemptDurationSec: null,
    retryUpload: null,
    current,
  }

  const describe = (row: VoiceoverClaimRow) => {
    const p = (row.payload ?? {}) as Record<string, unknown>
    const upload = row.operation === 'align_voiceover'
    const uploadPath = typeof p.uploadPath === 'string' ? p.uploadPath : null
    const file = uploadPath?.split('/').pop() ?? null
    const dot = file?.lastIndexOf('.') ?? -1
    return {
      mode: (upload ? 'upload' : 'generate') as 'upload' | 'generate',
      attemptVoiceId: !upload && typeof p.voiceId === 'string' ? p.voiceId : null,
      attemptChars: !upload && typeof p.chars === 'number' ? p.chars : null,
      attemptDurationSec: upload && typeof p.durationSec === 'number' ? p.durationSec : null,
      retryUpload:
        upload && file && dot > 0 && typeof p.durationSec === 'number'
          ? { attemptId: file.slice(0, dot), ext: file.slice(dot + 1), durationSec: p.durationSec }
          : null,
    }
  }

  const live = claims.find(
    (row) => row.state === 'generating' && isLiveClaim(row, row.operation as 'voiceover' | 'align_voiceover', now)
  )
  if (live) {
    const d = describe(live)
    return { ...base, state: 'generating', ...d, retryUpload: null, startedAt: live.started_at }
  }

  // The latest attempt either way (each operation has one reusable claim row). If it failed
  // - or went stale without settling - that is the lane's state, even over an older read.
  const latest = [...claims].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  if (latest && (latest.state === 'failed' || latest.state === 'generating')) {
    return { ...base, state: 'failed', ...describe(latest), failedAt: latest.updated_at }
  }
  return base
}
