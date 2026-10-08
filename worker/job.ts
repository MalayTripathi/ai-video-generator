import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EXPORT_CRF, EXPORT_DEV_SIZES, EXPORT_FPS, EXPORT_MOTION_UPSCALE } from '@/lib/config/export'
import { EXPORT_OUTPUT_SIZES } from '@/lib/config/storyboard'
import { devCapError } from '@/lib/export/dev-cap'
import { filmHash } from '@/lib/export/film-hash'
import { FILM_PROJECT_COLUMNS, FILM_SHOT_COLUMNS, filmInputFromRows } from '@/lib/export/film-input'
import { buildRenderPlan, type RenderPlan, type RenderSize } from '@/lib/export/render-plan'
import { parseExportSettings, type ExportSettings } from '@/lib/export/settings'
import { buildFilmTimeline, type FilmTimeline } from '@/lib/storyboard/film'
import type { ExportRow } from './claim'
import type { WorkerDb } from './config'
import { probe } from './ffmpeg'
import { renderExport } from './render'
import { applyRetention } from './retention'

/** A failure whose message is written to the row as-is - copy the person can act on. */
export class ExportJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportJobError'
  }
}

export const GENERIC_FAILURE = 'The render failed. Your settings and the mix are saved.'

export function exportDir(userId: string, projectId: string, exportId: string): string {
  return `${userId}/${projectId}/exports/${exportId}`
}

type ProjectRow = Parameters<typeof filmInputFromRows>[0] & { user_id: string }

/**
 * The job's film and render plan, from the project's rows - the Part E timeline function,
 * the same the page previews. The snapshot's motion and transition are the film defaults,
 * so a retry renders with the settings it was requested with.
 */
export function planExport(params: {
  project: ProjectRow
  shots: Parameters<typeof filmInputFromRows>[1]
  settings: ExportSettings
  isProduction: boolean
  size?: RenderSize
}): { timeline: FilmTimeline; plan: RenderPlan } {
  const { project, settings } = params
  const input = filmInputFromRows(
    { ...project, export_motion: settings.motion, export_transition: settings.transition },
    params.shots
  )
  const timeline = buildFilmTimeline(input)
  const capError = devCapError(timeline, params.isProduction)
  if (capError) throw new ExportJobError(capError)
  const size = params.size ?? (params.isProduction ? EXPORT_OUTPUT_SIZES : EXPORT_DEV_SIZES)[timeline.aspectRatio]
  const plan = buildRenderPlan(timeline, settings, { size, fps: EXPORT_FPS, crf: EXPORT_CRF, upscale: EXPORT_MOTION_UPSCALE })
  return { timeline, plan }
}

async function download(db: WorkerDb, storagePath: string, to: string): Promise<void> {
  const { data, error } = await db.storage.from('artifacts').download(storagePath)
  if (error || !data) throw new Error(`Could not download ${storagePath}: ${error?.message ?? 'no data'}`)
  await writeFile(to, Buffer.from(await data.arrayBuffer()))
}

async function upload(db: WorkerDb, storagePath: string, file: string, contentType: string): Promise<void> {
  const { error } = await db.storage.from('artifacts').upload(storagePath, await readFile(file), { contentType, upsert: true })
  if (error) throw new Error(`Could not upload ${storagePath}: ${error.message}`)
}

/**
 * Renders one claimed export and settles it. Every settle is conditional on the row still
 * rendering, so a job the stuck sweep has already failed stays failed (and its uploads are
 * removed). Never throws.
 */
export async function runJob(
  db: WorkerDb,
  row: ExportRow,
  deps: { ffmpeg: string; fontsDir: string | null; isProduction: boolean }
): Promise<'succeeded' | 'failed'> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'reelcraft-export-'))
  const dir = exportDir(row.user_id, row.project_id, row.id)
  const uploaded: string[] = []
  try {
    const settings = parseExportSettings(row.settings)
    if (!settings) throw new ExportJobError('This export’s settings could not be read. Export again.')

    const { data: project, error: projectError } = await db
      .from('projects')
      .select(`user_id, ${FILM_PROJECT_COLUMNS}`)
      .eq('id', row.project_id)
      .single()
    if (projectError || !project) throw new ExportJobError('The project could not be found.')
    const { data: shots, error: shotsError } = await db
      .from('shots')
      .select(FILM_SHOT_COLUMNS)
      .eq('project_id', row.project_id)
      .order('order_index', { ascending: true })
    if (shotsError) throw shotsError

    const { timeline, plan } = planExport({ project, shots: shots ?? [], settings, isProduction: deps.isProduction })

    const images = new Map<string, string>()
    for (const segment of plan.segments) {
      if (images.has(segment.imagePath)) continue
      const local = path.join(workDir, `image-${images.size}${path.extname(segment.imagePath) || '.webp'}`)
      await download(db, segment.imagePath, local)
      images.set(segment.imagePath, local)
    }
    let voice: string | null = null
    if (plan.audio.voice) {
      voice = path.join(workDir, `voice${path.extname(plan.audio.voice.path) || '.mp3'}`)
      await download(db, plan.audio.voice.path, voice)
    }
    let music: string | null = null
    if (plan.audio.music) {
      music = path.join(workDir, `music${path.extname(plan.audio.music.path) || '.mp3'}`)
      await download(db, plan.audio.music.path, music)
    }

    let lastWrite = 0
    let lastPct = 0
    const outputs = await renderExport({
      plan,
      inputs: { images, voice, music },
      workDir,
      ffmpeg: deps.ffmpeg,
      fontsDir: deps.fontsDir,
      onProgress: (fraction) => {
        const pct = Math.min(99, Math.floor(fraction * 100))
        const now = Date.now()
        if (pct <= lastPct || now - lastWrite < 1000) return
        lastPct = pct
        lastWrite = now
        void db.from('exports').update({ progress: pct }).eq('id', row.id).eq('status', 'rendering').then(
          () => {},
          () => {}
        )
      },
    })

    const mp4Path = `${dir}/film.mp4`
    await upload(db, mp4Path, outputs.mp4, 'video/mp4')
    uploaded.push(mp4Path)
    let srtPath: string | null = null
    if (outputs.srt) {
      srtPath = `${dir}/captions.srt`
      await upload(db, srtPath, outputs.srt, 'application/x-subrip')
      uploaded.push(srtPath)
    }
    let chaptersPath: string | null = null
    if (outputs.chaptersTxt) {
      chaptersPath = `${dir}/chapters.txt`
      await upload(db, chaptersPath, outputs.chaptersTxt, 'text/plain')
      uploaded.push(chaptersPath)
    }
    const size = (await stat(outputs.mp4)).size
    const probed = await probe(deps.ffmpeg, outputs.mp4)

    const { data: settled, error: settleError } = await db
      .from('exports')
      .update({
        status: 'succeeded',
        progress: 100,
        mp4_path: mp4Path,
        srt_path: srtPath,
        chapters_path: chaptersPath,
        size_bytes: size,
        duration_sec: probed.durationSec ?? timeline.totalSec,
        // The film actually rendered - it may have been edited since the request.
        film_hash: filmHash(timeline),
        finished_at: new Date().toISOString(),
        error: null,
      })
      .eq('id', row.id)
      .eq('status', 'rendering')
      .select('id')
      .maybeSingle()
    if (settleError) throw settleError
    if (!settled) {
      await db.storage.from('artifacts').remove(uploaded)
      return 'failed'
    }
    await applyRetention(db, row.project_id).catch((err) =>
      console.warn('[export] retention failed', row.project_id, err instanceof Error ? err.message : err)
    )
    return 'succeeded'
  } catch (err) {
    const message = err instanceof ExportJobError ? err.message : GENERIC_FAILURE
    console.error('[export] job failed', row.id, err instanceof Error ? err.message : err, (err as { stderr?: string }).stderr?.slice(-2000) ?? '')
    if (uploaded.length > 0) await db.storage.from('artifacts').remove(uploaded).catch(() => {})
    await db
      .from('exports')
      .update({ status: 'failed', error: message, finished_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'rendering')
      .then(
        () => {},
        (e: unknown) => console.error('[export] could not settle failed', row.id, e)
      )
    return 'failed'
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
