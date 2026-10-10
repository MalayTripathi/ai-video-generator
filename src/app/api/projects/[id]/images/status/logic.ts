import type { createClient } from '@/lib/supabase/server'
// Type-only: the route injects the real function, so a plain-Node test can pass a fake.
import type { getBalance as getBalanceType } from '@/lib/credits/balance'
import { pricedAspectRatio, storyboardImagePriceKey, usableReferencePaths } from '@/lib/images/price-key'
import { STATUS_POLL_INTERVAL_MS, STORYBOARD_SIGNED_URL_EXPIRES_S } from '@/lib/config/storyboard'
import { deriveImageState, type ImageState } from '@/lib/storyboard/image-state'
import { liveImageCommittedCredits, storyboardImageCredits, storyboardThumbPath } from '../logic'
import { isLiveClaim } from '@/lib/generations/claim'
import { liveAudioCommittedCredits } from '@/lib/voiceover/committed'
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
  /** What drawing this frame costs now: the project's image quality and size, plus this shot's references. */
  imageCredits: number
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
  /** This read replaced one the shots were fitted to, and a person has retimed shots by
   * hand since that fit - so it was not refitted silently; the Storyboard asks first. */
  refitPending: boolean
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

/** The project's current music, when there is one. */
export type CurrentMusic = {
  /** The stored file (projects.music_path) - what the film timeline names; audioUrl is its signed URL. */
  path: string
  audioUrl: string | null
  durationSec: number
  source: 'generated' | 'uploaded'
  generatedAt: string
  loop: boolean
  muted: boolean
}

export type MusicStatus = {
  /** none: nothing yet; generating: a run is in flight; failed: the latest run didn't land. */
  state: 'none' | 'generating' | 'failed' | 'present'
  startedAt: string | null
  failedAt: string | null
  /** The in-flight or failed run's requested length, for the "writing N seconds" line. */
  attemptSec: number | null
  current: CurrentMusic | null
}

export type ImageStatusData = {
  shots: ShotImageStatus[]
  voiceover: VoiceoverStatus
  music: MusicStatus
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
 * ONE batched signing call for storyboard artifacts: each image path plus its best-effort
 * `{attemptId}_thumb.webp`, and any extra paths (the voiceover). A missing thumbnail comes
 * back as a per-entry error - the expected fallback, not a failure - so it is simply absent
 * from the map; readers fall back to the full image. A failed batch logs and returns empty.
 */
export async function signStoryboardImages(
  supabase: SupabaseServerClient,
  projectId: string,
  imagePaths: readonly (string | null)[],
  extraPaths: readonly string[] = []
): Promise<Map<string, string>> {
  const paths = [...extraPaths]
  for (const path of imagePaths) {
    if (path) paths.push(path, storyboardThumbPath(path))
  }
  const urlByPath = new Map<string, string>()
  if (paths.length === 0) return urlByPath
  const { data: signed, error } = await supabase.storage
    .from('artifacts')
    .createSignedUrls(paths, STORYBOARD_SIGNED_URL_EXPIRES_S)
  if (error) {
    console.error(`[images/status] batch signing failed for project ${projectId}:`, error.message)
    return urlByPath
  }
  for (const entry of signed ?? []) {
    if (!entry.error && entry.signedUrl && entry.path) urlByPath.set(entry.path, entry.signedUrl)
  }
  return urlByPath
}

/** The thumbnail's signed URL for an image, falling back to the full image's. */
export function storyboardThumbUrl(urlByPath: Map<string, string>, imagePath: string | null): string | null {
  if (!imagePath) return null
  return urlByPath.get(storyboardThumbPath(imagePath)) ?? urlByPath.get(imagePath) ?? null
}

// The project columns the voiceover and music lanes derive from. A page that has already
// read its project for this user selects these too and passes the row in.
export const IMAGE_STATUS_PROJECT_COLUMNS =
  'aspect_ratio, image_model, image_quality, audio_path, voice_id, language_code, total_duration_sec, voiceover_source, voiceover_generated_at, voiceover_muted, voiceover_spans, voiceover_words, last_fit_at, last_manual_retime_at, music_path, music_duration_sec, music_source, music_generated_at, music_loop, music_muted' as const

type StatusProjectRow = VoiceoverProjectRow &
  MusicProjectRow & { music_path: string | null; aspect_ratio: string | null; image_model: string; image_quality: string }

/**
 * Per-shot storyboard image state for one project, cheap enough to poll: two narrow
 * selects, a pure derivation, ONE batched signing call for every full image and thumbnail,
 * and the balance the case-2 banner needs. imagePath is present for every state, so a
 * failed regenerate still shows the image it was replacing. Every read that doesn't need
 * another's answer runs at once; the child reads are RLS-scoped to the project's owner, so
 * running them beside the ownership read exposes nothing. `project` is a row the caller
 * already read for this user (with IMAGE_STATUS_PROJECT_COLUMNS) - the poll never passes it.
 */
export async function loadImageStatuses(params: {
  supabase: SupabaseServerClient
  projectId: string
  userId: string
  getBalance: typeof getBalanceType
  project?: StatusProjectRow
}): Promise<ImageStatusResult> {
  const { supabase, projectId, userId, getBalance } = params

  const loadBalance = async (): Promise<number | null> => {
    try {
      const [liveImages, liveAudio, balance] = await Promise.all([
        liveImageCommittedCredits(supabase, userId),
        liveAudioCommittedCredits(supabase, userId),
        getBalance(userId),
      ])
      return Math.max(0, balance - (liveImages + liveAudio))
    } catch (err) {
      console.error(`[images/status] balance unreadable for project ${projectId}:`, err)
      return null
    }
  }

  const [projectResult, shotsResult, claimsResult, voiceoverClaimsResult, balanceCredits] = await Promise.all([
    params.project
      ? { data: params.project, error: null }
      : supabase
          .from('projects')
          .select(IMAGE_STATUS_PROJECT_COLUMNS)
          .eq('id', projectId)
          .eq('user_id', userId)
          .maybeSingle(),
    supabase
      .from('shots')
      .select('id, image_path, image_stale, shot_elements(elements(reference_image_path, deleted_at))')
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
      .in('operation', ['voiceover', 'align_voiceover', 'background_music']),
    loadBalance(),
  ])
  if (projectResult.error) return { ok: false, status: 500, error: projectResult.error.message }
  const project = projectResult.data
  if (!project) return { ok: false, status: 404, error: 'Project not found' }
  if (shotsResult.error) return { ok: false, status: 500, error: shotsResult.error.message }
  if (claimsResult.error) return { ok: false, status: 500, error: claimsResult.error.message }
  if (voiceoverClaimsResult.error) return { ok: false, status: 500, error: voiceoverClaimsResult.error.message }
  const shotRows = shotsResult.data ?? []

  const urlByPath = await signStoryboardImages(
    supabase,
    projectId,
    shotRows.map((shot) => shot.image_path),
    [project.audio_path, project.music_path].filter((p): p is string => p !== null)
  )

  const aspectRatio = pricedAspectRatio(project.aspect_ratio)
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
      imageCredits: storyboardImageCredits(
        storyboardImagePriceKey({
          aspectRatio,
          imageModel: project.image_model,
          imageQuality: project.image_quality,
          referenceCount: usableReferencePaths(shot.shot_elements).length,
        })
      ),
    }
  })

  const audioClaims = voiceoverClaimsResult.data ?? []
  const voiceover = deriveVoiceoverStatus(
    project,
    audioClaims.filter((row) => row.operation !== 'background_music'),
    project.audio_path ? (urlByPath.get(project.audio_path) ?? null) : null,
    now
  )
  const music = deriveMusicStatus(
    project,
    audioClaims.find((row) => row.operation === 'background_music') ?? null,
    project.music_path ? (urlByPath.get(project.music_path) ?? null) : null,
    now
  )

  return {
    ok: true,
    data: {
      shots,
      voiceover,
      music,
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
  last_fit_at?: string | null
  last_manual_retime_at?: string | null
}

/**
 * Whether a regenerated read is waiting on the person's "Refit timing?" answer: the shots
 * were fitted before (so this is not the first read), a manual retime came after that fit,
 * and this read is newer than both - answering either way (refit stamps last_fit_at, keep
 * stamps last_manual_retime_at) clears it.
 */
export function isRefitPending(project: Pick<VoiceoverProjectRow, 'voiceover_generated_at' | 'last_fit_at' | 'last_manual_retime_at'>): boolean {
  const at = (value: string | null | undefined) => (value ? Date.parse(value) : null)
  const generated = at(project.voiceover_generated_at)
  const fit = at(project.last_fit_at)
  const manual = at(project.last_manual_retime_at)
  if (generated === null || fit === null || manual === null) return false
  return manual > fit && generated > manual
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
          refitPending: isRefitPending(project),
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

type MusicProjectRow = {
  music_path: string | null
  music_duration_sec: number | null
  music_source: string | null
  music_generated_at: string | null
  music_loop: boolean
  music_muted: boolean | null
}

/**
 * The music lane's state, from the project's current-music columns plus its one claim row.
 * In flight wins; then a failed run newer than the current music (an upload writes no
 * claim, so a later upload supersedes an older failure); then the music itself.
 */
export function deriveMusicStatus(
  project: MusicProjectRow,
  claim: VoiceoverClaimRow | null,
  audioUrl: string | null,
  now: number
): MusicStatus {
  const current: CurrentMusic | null =
    project.music_path && project.music_duration_sec !== null && project.music_generated_at
      ? {
          path: project.music_path,
          audioUrl,
          durationSec: Number(project.music_duration_sec),
          source: project.music_source === 'uploaded' ? 'uploaded' : 'generated',
          generatedAt: project.music_generated_at,
          loop: project.music_loop,
          muted: project.music_muted ?? false,
        }
      : null
  const base: MusicStatus = { state: current ? 'present' : 'none', startedAt: null, failedAt: null, attemptSec: null, current }
  if (!claim) return base

  const p = (claim.payload ?? {}) as Record<string, unknown>
  const attemptSec = typeof p.requestedSec === 'number' ? p.requestedSec : null
  if (claim.state === 'generating' && isLiveClaim(claim, 'background_music', now)) {
    return { ...base, state: 'generating', startedAt: claim.started_at, attemptSec }
  }
  const unsettled = claim.state === 'failed' || claim.state === 'generating'
  const newerThanMusic = !current || claim.updated_at > current.generatedAt
  if (unsettled && newerThanMusic) return { ...base, state: 'failed', failedAt: claim.updated_at, attemptSec }
  return base
}
