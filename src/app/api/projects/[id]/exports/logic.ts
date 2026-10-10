import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  EXPORT_DEV_SIZES,
  EXPORT_HISTORY_LIMIT,
  EXPORT_RETENTION,
  EXPORT_SIGNED_URL_EXPIRES_S,
  exportIsProduction,
} from '@/lib/config/export'
import { EXPORT_OUTPUT_SIZES, STATUS_POLL_INTERVAL_MS } from '@/lib/config/storyboard'
import type { ExportStatus } from '@/lib/config/enums'
import { filmHash } from '@/lib/export/film-hash'
import { currentRead, FILM_PROJECT_COLUMNS, FILM_SHOT_COLUMNS, filmInputFromRows } from '@/lib/export/film-input'
import { parseExportSettings, resolveExportSettings, type ExportSettings } from '@/lib/export/settings'
import { buildFilmTimeline } from '@/lib/storyboard/film'
import { isUniqueViolation } from '@/lib/shot-key'
import { createServiceRoleClient } from '@/lib/supabase/service-role'

// Export jobs (Storyboard F). Reads go through the session client (RLS: owner SELECT);
// every write goes through the service-role client, since exports has no authenticated
// write policy - always after the session client has verified the project (and export)
// belong to the user, and always scoped by that row's id. Its one read is a count. The worker (worker/) claims and settles rows; the page polls this list.
// Export is free: no balance check, no ledger row.

type Db = SupabaseClient<Database>

export type ExportHistoryRow = {
  id: string
  status: ExportStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  progress: number
  error: string | null
  sizeBytes: number | null
  durationSec: number | null
  filmHash: string
  settings: ExportSettings | null
  /** The rendered frame size, from the snapshot's aspect ratio. */
  width: number | null
  height: number | null
  /** Queued rows: 1 = next to render. */
  queuePosition: number | null
  /** Rendering rows: estimated from progress so far; null until there is any. */
  secondsLeft: number | null
  urls: {
    watch: string | null
    download: string | null
    srt: string | null
    chapters: string | null
  } | null
}

export type ExportsData = { rows: ExportHistoryRow[]; pollIntervalMs: number }

export type ExportsResult<T> =
  | { ok: true; status: 200 | 201; data: T }
  | { ok: false; status: 404 | 409 | 500; error: string }

const ACTIVE_CONFLICT = 'An export is already queued or rendering for this project.'
const NOT_READY = 'Export unlocks once every frame is ready.'

/** null when the user owns the project; otherwise the result to return - a failed read is a
 * server error, never a 404, and only a missing row is `notFound`. */
async function projectGate(
  supabase: Db,
  projectId: string,
  userId: string,
  notFound: string
): Promise<{ ok: false; status: 404 | 500; error: string } | null> {
  const { data, error } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', userId).maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  return data ? null : { ok: false, status: 404, error: notFound }
}

function outputSize(settings: ExportSettings | null) {
  if (!settings) return null
  return (exportIsProduction() ? EXPORT_OUTPUT_SIZES : EXPORT_DEV_SIZES)[settings.aspectRatio]
}

function fileBase(createdAt: string): string {
  return `reelcraft-${createdAt.slice(0, 16).replace(/[:T]/g, '-')}`
}

async function signed(supabase: Db, path: string | null, download?: string): Promise<string | null> {
  if (!path) return null
  const { data } = await supabase.storage
    .from('artifacts')
    .createSignedUrl(path, EXPORT_SIGNED_URL_EXPIRES_S, download ? { download } : undefined)
  return data?.signedUrl ?? null
}

// Every column the history rows are built from (not project_id/user_id, which the read
// filters on, nor the worker's bookkeeping).
const EXPORT_HISTORY_COLUMNS =
  'id, status, settings, created_at, started_at, finished_at, progress, error, size_bytes, duration_sec, film_hash, mp4_path, srt_path, chapters_path'

/** The project's export history, newest first: the kept succeeded exports plus recent others.
 * `projectVerified` skips the ownership read when the caller (a page) has just read the
 * project for this user itself; the poll endpoint never passes it. */
export async function loadExports(params: {
  supabase: Db
  service?: Db
  projectId: string
  userId: string
  now?: number
  projectVerified?: boolean
}): Promise<ExportsResult<ExportsData>> {
  const { supabase, projectId, userId } = params
  const service = params.service ?? createServiceRoleClient()
  const now = params.now ?? Date.now()
  if (!params.projectVerified) {
    const refused = await projectGate(supabase, projectId, userId, 'Project not found')
    if (refused) return refused
  }

  const { data, error } = await supabase
    .from('exports')
    .select(EXPORT_HISTORY_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(EXPORT_RETENTION + EXPORT_HISTORY_LIMIT)
  if (error) return { ok: false, status: 500, error: error.message }

  let succeeded = 0
  let others = 0
  const kept = (data ?? []).filter((row) => {
    if (row.status === 'succeeded') return ++succeeded <= EXPORT_RETENTION
    return ++others <= EXPORT_HISTORY_LIMIT
  })

  const rows = await Promise.all(
    kept.map(async (row): Promise<ExportHistoryRow> => {
      const settings = parseExportSettings(row.settings)
      const size = outputSize(settings)
      let queuePosition: number | null = null
      if (row.status === 'queued') {
        // Every user's queue is one queue: count what the worker takes first (service role;
        // a count only - no other user's row is read).
        const { count } = await service
          .from('exports')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'queued')
          .lte('created_at', row.created_at)
        queuePosition = count ?? null
      }
      let secondsLeft: number | null = null
      if (row.status === 'rendering' && row.started_at && row.progress > 0) {
        const elapsed = (now - new Date(row.started_at).getTime()) / 1000
        secondsLeft = Math.max(1, Math.round((elapsed * (100 - row.progress)) / row.progress))
      }
      const base = fileBase(row.created_at)
      let urls: ExportHistoryRow['urls'] = null
      if (row.status === 'succeeded') {
        const [watch, download, srt, chapters] = await Promise.all([
          signed(supabase, row.mp4_path),
          signed(supabase, row.mp4_path, `${base}.mp4`),
          signed(supabase, row.srt_path, `${base}.srt`),
          signed(supabase, row.chapters_path, `${base}-chapters.txt`),
        ])
        urls = { watch, download, srt, chapters }
      }
      return {
        id: row.id,
        status: row.status as ExportStatus,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        progress: row.progress,
        error: row.error,
        sizeBytes: row.size_bytes,
        durationSec: row.duration_sec,
        filmHash: row.film_hash,
        settings,
        width: size?.width ?? null,
        height: size?.height ?? null,
        queuePosition,
        secondsLeft,
        urls,
      }
    })
  )
  return { ok: true, status: 200, data: { rows, pollIntervalMs: STATUS_POLL_INTERVAL_MS } }
}

/** The current film's hash and resolved settings - or why it cannot be exported yet. */
async function currentFilm(
  supabase: Db,
  projectId: string,
  userId: string
): Promise<{ ok: true; hash: string; settings: ExportSettings } | { ok: false; status: 404 | 409 | 500; error: string }> {
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select(FILM_PROJECT_COLUMNS)
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  // A failed read is a server error, never a 404 - only a missing row is.
  if (projectError) return { ok: false, status: 500, error: projectError.message }
  if (!project) return { ok: false, status: 404, error: 'Project not found' }
  const { data: shots, error } = await supabase
    .from('shots')
    .select(FILM_SHOT_COLUMNS)
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })
  if (error) return { ok: false, status: 500, error: error.message }
  const input = filmInputFromRows(project, shots ?? [])
  const timeline = buildFilmTimeline(input)
  // The page's lock, enforced here too: every in-film frame has an image.
  if (timeline.segments.length === 0 || timeline.segments.some((s) => !s.imagePath)) {
    return { ok: false, status: 409, error: NOT_READY }
  }
  const settings = resolveExportSettings(project, { hasVoiceover: currentRead(project) !== null, aspectRatio: input.aspectRatio })
  return { ok: true, hash: filmHash(timeline), settings }
}

async function insertQueued(
  service: Db,
  row: { userId: string; projectId: string; settings: ExportSettings; hash: string }
): Promise<ExportsResult<{ id: string }>> {
  const { data, error } = await service
    .from('exports')
    .insert({
      user_id: row.userId,
      project_id: row.projectId,
      status: 'queued',
      settings: row.settings,
      film_hash: row.hash,
      progress: 0,
    })
    .select('id')
    .single()
  if (error) {
    if (isUniqueViolation(error)) return { ok: false, status: 409, error: ACTIVE_CONFLICT }
    return { ok: false, status: 500, error: error.message }
  }
  return { ok: true, status: 201, data: { id: data.id } }
}

/** "Export slideshow": queue one export of the current film with the current settings. */
export async function createExport(params: {
  supabase: Db
  service?: Db
  projectId: string
  userId: string
}): Promise<ExportsResult<{ id: string }>> {
  const film = await currentFilm(params.supabase, params.projectId, params.userId)
  if (!film.ok) return film
  return insertQueued(params.service ?? createServiceRoleClient(), {
    userId: params.userId,
    projectId: params.projectId,
    settings: film.settings,
    hash: film.hash,
  })
}

async function ownedExport(supabase: Db, projectId: string, exportId: string) {
  const { data } = await supabase
    .from('exports')
    .select('id, status, settings')
    .eq('id', exportId)
    .eq('project_id', projectId)
    .maybeSingle()
  return data
}

/** Cancel is allowed only while queued - a conditional update, so a row the worker just claimed is refused. */
export async function cancelExport(params: {
  supabase: Db
  service?: Db
  projectId: string
  userId: string
  exportId: string
}): Promise<ExportsResult<{ id: string }>> {
  const refused = await projectGate(params.supabase, params.projectId, params.userId, 'Project not found')
  if (refused) return refused
  const row = await ownedExport(params.supabase, params.projectId, params.exportId)
  if (!row) return { ok: false, status: 404, error: 'Export not found' }
  const { data, error } = await (params.service ?? createServiceRoleClient())
    .from('exports')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'queued')
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 409, error: 'Only a queued export can be cancelled.' }
  return { ok: true, status: 200, data: { id: data.id } }
}

/** Retry a failed export: a new row with the same settings snapshot, of the current film. */
export async function retryExport(params: {
  supabase: Db
  service?: Db
  projectId: string
  userId: string
  exportId: string
}): Promise<ExportsResult<{ id: string }>> {
  const row = await ownedExport(params.supabase, params.projectId, params.exportId)
  if (!row) return { ok: false, status: 404, error: 'Export not found' }
  const refused = await projectGate(params.supabase, params.projectId, params.userId, 'Export not found')
  if (refused) return refused
  if (row.status !== 'failed') return { ok: false, status: 409, error: 'Only a failed export can be retried.' }
  const settings = parseExportSettings(row.settings)
  if (!settings) return { ok: false, status: 409, error: 'This export’s settings could not be read. Export again.' }
  const film = await currentFilm(params.supabase, params.projectId, params.userId)
  if (!film.ok) return film
  return insertQueued(params.service ?? createServiceRoleClient(), { userId: params.userId, projectId: params.projectId, settings, hash: film.hash })
}
