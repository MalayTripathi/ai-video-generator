import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  audioGraph,
  hasAudio,
  loudnessAnalysisFilter,
  loudnessFinalFilter,
  parseLoudnessMeasure,
  videoGraph,
  type RenderPlan,
} from '@/lib/export/render-plan'
import { runFfmpeg } from './ffmpeg'

// Executes a render plan over local files. No database and no storage - the job downloads
// the inputs and uploads the outputs - so the render itself runs in a test against a
// fixture built in-test.

export type RenderInputs = {
  /** Local file for each still, keyed by the plan's image path. */
  images: ReadonlyMap<string, string>
  voice: string | null
  music: string | null
}

export type RenderOutputs = {
  mp4: string
  srt: string | null
  chaptersTxt: string | null
}

// Share of the progress bar the segment passes take; the assembly pass takes the rest.
const SEGMENT_SHARE = 0.6

export async function renderExport(params: {
  plan: RenderPlan
  inputs: RenderInputs
  workDir: string
  ffmpeg: string
  fontsDir: string | null
  onProgress?: (fraction: number) => void
}): Promise<RenderOutputs> {
  const { plan, inputs, workDir, ffmpeg } = params
  const report = params.onProgress ?? (() => {})
  if (plan.segments.length === 0) throw new Error('The film has no shots.')
  const totalFrames = plan.segments.reduce((n, s) => n + s.frames, 0)

  // 1. Each segment's still into a clip of exactly its on-screen frames. An intermediate is
  //    near-lossless (CRF 12) so the final encode is the only real generation loss.
  const clips: string[] = []
  let doneFrames = 0
  for (const segment of plan.segments) {
    const image = inputs.images.get(segment.imagePath)
    if (!image) throw new Error(`Missing local file for ${segment.imagePath}`)
    const out = path.join(workDir, `segment-${segment.index}.mp4`)
    await runFfmpeg(
      ffmpeg,
      ['-i', image, '-vf', segment.filter, '-frames:v', String(segment.frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', out],
      {
        onOutTimeSec: (sec) =>
          report((SEGMENT_SHARE * (doneFrames + Math.min(segment.frames, sec * plan.fps))) / totalFrames),
      }
    )
    doneFrames += segment.frames
    report((SEGMENT_SHARE * doneFrames) / totalFrames)
    clips.push(out)
  }

  // 2. Sidecars.
  let assPath: string | null = null
  if (plan.sidecars.ass) {
    assPath = path.join(workDir, 'captions.ass')
    await writeFile(assPath, plan.sidecars.ass)
  }
  let srtPath: string | null = null
  if (plan.sidecars.srt) {
    srtPath = path.join(workDir, 'captions.srt')
    await writeFile(srtPath, plan.sidecars.srt)
  }
  let chaptersPath: string | null = null
  if (plan.sidecars.chaptersTxt) {
    chaptersPath = path.join(workDir, 'chapters.txt')
    await writeFile(chaptersPath, plan.sidecars.chaptersTxt)
  }
  let metaPath: string | null = null
  if (plan.sidecars.ffmetadata) {
    metaPath = path.join(workDir, 'chapters.ffmeta')
    await writeFile(metaPath, plan.sidecars.ffmetadata)
  }

  // Inputs after the clips: voice, music, chapter metadata - each only when present.
  const audioArgs: string[] = []
  let next = clips.length
  const voiceInput = plan.audio.voice && inputs.voice ? next++ : null
  if (voiceInput !== null) audioArgs.push('-i', inputs.voice!)
  const musicInput = plan.audio.music && inputs.music ? next++ : null
  if (musicInput !== null) audioArgs.push('-i', inputs.music!)
  const audio = audioGraph(plan, voiceInput, musicInput)

  // 3. Loudness analysis (loudnorm's first pass) over the mix alone.
  let measured = null
  if (hasAudio(plan) && (voiceInput !== null || musicInput !== null)) {
    // The analysis graph sees only the audio inputs, so they are renumbered from 0.
    const analysisAudio = audioGraph(plan, voiceInput !== null ? 0 : null, musicInput !== null ? (voiceInput !== null ? 1 : 0) : null)
    const { stderr } = await runFfmpeg(ffmpeg, [
      ...audioArgs,
      '-filter_complex',
      `${analysisAudio};${loudnessAnalysisFilter(plan)}`,
      '-map',
      '[aout]',
      '-f',
      'null',
      '-',
    ])
    measured = parseLoudnessMeasure(stderr)
  }

  // 4. Assembly: join, captions, normalised mix, chapters.
  const mp4 = path.join(workDir, 'film.mp4')
  const metaArgs = metaPath ? ['-i', metaPath] : []
  const metaInput = metaPath ? next++ : null
  const graph = [videoGraph(plan, assPath, params.fontsDir), audio, loudnessFinalFilter(plan, measured)].join(';')
  await runFfmpeg(
    ffmpeg,
    [
      ...clips.flatMap((c) => ['-i', c]),
      ...audioArgs,
      ...metaArgs,
      '-filter_complex',
      graph,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      ...(metaInput !== null ? ['-map_metadata', String(metaInput), '-map_chapters', String(metaInput)] : []),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      String(plan.crf),
      '-r',
      String(plan.fps),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-t',
      plan.totalSec.toFixed(3),
      '-movflags',
      '+faststart',
      mp4,
    ],
    { onOutTimeSec: (sec) => report(SEGMENT_SHARE + (1 - SEGMENT_SHARE) * Math.min(1, sec / plan.totalSec)) }
  )
  report(1)
  return { mp4, srt: srtPath, chaptersTxt: chaptersPath }
}
