import { CAPTION_STYLE_PRESETS, LOUDNESS_TARGETS } from '@/lib/config/storyboard'
import { dbToGain, motionTransform, type DuckPoint, type FilmTimeline, type MusicPlay } from '@/lib/storyboard/film'
import type { Motion } from '@/lib/config/enums'
import { captionLines, toAss, toSrt } from './captions'
import { chaptersFfmetadata, chaptersTxt } from './chapters'
import { captionsBurned, captionsSrt, type ExportSettings } from './settings'

// The export render as data: which ffmpeg passes run, over what, with which filters. Built
// only from the Part E film timeline (buildFilmTimeline), so the render is the film the
// page previews. Pure - the worker turns it into processes and files.
//
// Passes:
//   1. one per segment: the still, scaled up (EXPORT_MOTION_UPSCALE) so the move lands on
//      sub-pixel positions, then zoompan'd into a clip of exactly its on-screen frames;
//   2. loudness analysis of the audio mix (loudnorm's first pass), when there is audio;
//   3. assembly: the clips joined (xfade for a dissolve, concat for a cut), captions burned
//      in when chosen, the mix normalised with the measured values, chapters embedded.

export type RenderSize = { width: number; height: number }

export type SegmentPass = {
  index: number
  shotId: string
  imagePath: string
  motion: Motion
  frames: number
  /** The -vf chain for this segment's still. */
  filter: string
}

export type RenderPlan = {
  size: RenderSize
  fps: number
  crf: number
  totalSec: number
  segments: SegmentPass[]
  /** Between segment k and k+1: the dissolve's length in frames (0 = a hard cut). */
  joinFrames: number[]
  audio: {
    voice: { path: string; gainDb: number } | null
    /** The film's music schedule (buildFilmTimeline): its passes, where it ends, its end fade. */
    music: {
      path: string
      gainDb: number
      duck: DuckPoint[]
      plays: MusicPlay[]
      endSec: number
      endFadeSec: number
    } | null
  }
  loudness: { i: number; tp: number; lra: number }
  burnCaptions: boolean
  sidecars: {
    srt: string | null
    ass: string | null
    chaptersTxt: string | null
    ffmetadata: string | null
  }
}

const n = (value: number) => Number(value.toFixed(6)).toString()

/**
 * The zoompan expressions for one motion over `frames` output frames. motionTransform draws
 * the (frame-covering) still scaled by `scale` about its centre and offset by x/yPct of the
 * frame; the visible window in the still's own coordinates is therefore
 * left = w/2 − (w/2 + xPct·w/100)/scale, width w/scale - exactly zoompan's x and zoom.
 */
export function zoompanExpr(motion: Motion, frames: number): { z: string; x: string; y: string } {
  const a = motionTransform(motion, 0)
  const b = motionTransform(motion, 1)
  const p = frames > 1 ? `(on/${frames - 1})` : '0'
  const lerp = (from: number, to: number) => (from === to ? n(from) : `(${n(from)}+${n(to - from)}*${p})`)
  const z = lerp(a.scale, b.scale)
  const xp = lerp(a.xPct / 100, b.xPct / 100)
  const yp = lerp(a.yPct / 100, b.yPct / 100)
  return {
    z,
    x: `iw/2-(iw/2+${xp}*iw)/zoom`,
    y: `ih/2-(ih/2+${yp}*ih)/zoom`,
  }
}

/** The music's duck as a linear-gain ffmpeg expression of t (piecewise linear, like duckAt). Used single-quoted. */
export function duckExpr(points: readonly DuckPoint[]): string {
  if (points.length === 0) return '1'
  const g = (db: number) => n(dbToGain(db))
  let expr = '1'
  for (let i = points.length - 1; i >= 1; i--) {
    const a = points[i - 1]
    const b = points[i]
    const span = b.t - a.t
    const value =
      span <= 0 || a.db === b.db
        ? g(b.db)
        : `pow(10,(${n(a.db)}+${n(b.db - a.db)}*(t-${n(a.t)})/${n(span)})/20)`
    expr = `if(lt(t,${n(b.t)}),${value},${expr})`
  }
  return `if(lt(t,${n(points[0].t)}),1,${expr})`
}

export function buildRenderPlan(
  timeline: FilmTimeline,
  settings: ExportSettings,
  opts: { size: RenderSize; fps: number; crf: number; upscale: number }
): RenderPlan {
  const { size, fps, upscale } = opts
  const bw = size.width * upscale
  const bh = size.height * upscale

  const segments: SegmentPass[] = timeline.segments.map((segment, index) => {
    if (!segment.imagePath) throw new Error(`Frame ${segment.shotIndex + 1} has no image yet.`)
    const frames = Math.max(1, Math.round((segment.showToSec - segment.showFromSec) * fps))
    const zp = zoompanExpr(segment.motion, frames)
    const filter = [
      `scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${bw}:${bh}`,
      `zoompan=z='${zp.z}':x='${zp.x}':y='${zp.y}':d=${frames}:s=${size.width}x${size.height}:fps=${fps}`,
      'setsar=1',
      'format=yuv420p',
    ].join(',')
    return { index, shotId: segment.shotId, imagePath: segment.imagePath, motion: segment.motion, frames, filter }
  })

  // A split shot's two segments meet at a cut; every other boundary is the shot's join.
  const joinFrames = timeline.segments.slice(0, -1).map((segment, k) => {
    if (timeline.segments[k + 1].shotId === segment.shotId) return 0
    const join = timeline.joins.find((j) => j.shotId === segment.shotId)
    return join && join.transition === 'dissolve' ? Math.round(join.dissolveSec * fps) : 0
  })

  const burn = captionsBurned(settings.captions)
  const srt = captionsSrt(settings.captions)
  const lines = burn || srt ? captionLines(timeline.lines, timeline.words) : []
  const hasChapters = timeline.chapters.length > 0

  return {
    size,
    fps,
    crf: opts.crf,
    totalSec: timeline.totalSec,
    segments,
    joinFrames,
    audio: {
      voice: timeline.audio.voice ? { path: timeline.audio.voice.path, gainDb: timeline.audio.voice.gainDb } : null,
      music: timeline.audio.music
        ? {
            path: timeline.audio.music.path,
            gainDb: timeline.audio.music.gainDb,
            duck: timeline.audio.duck,
            plays: timeline.audio.music.plays,
            endSec: timeline.audio.music.endSec,
            endFadeSec: timeline.audio.music.endFadeSec,
          }
        : null,
    },
    loudness: LOUDNESS_TARGETS[settings.loudness],
    burnCaptions: burn && lines.length > 0,
    sidecars: {
      srt: srt && lines.length > 0 ? toSrt(lines) : null,
      ass: burn && lines.length > 0 ? toAss(lines, CAPTION_STYLE_PRESETS[settings.captionStyle], settings.captionPosition, size) : null,
      chaptersTxt: hasChapters ? chaptersTxt(timeline.chapters) : null,
      ffmetadata: hasChapters ? chaptersFfmetadata(timeline.chapters, timeline.totalSec) : null,
    },
  }
}

// ---------------------------------------------------------------------------------------
// Filter graphs over local files (the worker supplies the paths)
// ---------------------------------------------------------------------------------------

/** Escapes a path for use as a filter option value inside a filtergraph. */
export function filterPath(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`
}

/** The video chain over inputs 0..n−1 (the segment clips), ending in [vout]. */
export function videoGraph(plan: RenderPlan, assPath: string | null, fontsDir: string | null): string {
  const parts: string[] = []
  let acc = '[0:v]'
  let accFrames = plan.segments[0]?.frames ?? 0
  for (let k = 1; k < plan.segments.length; k++) {
    const d = plan.joinFrames[k - 1]
    const out = `[v${k}]`
    if (d > 0) {
      parts.push(`${acc}[${k}:v]xfade=transition=fade:duration=${n(d / plan.fps)}:offset=${n((accFrames - d) / plan.fps)}${out}`)
      accFrames += plan.segments[k].frames - d
    } else {
      parts.push(`${acc}[${k}:v]concat=n=2:v=1:a=0${out}`)
      accFrames += plan.segments[k].frames
    }
    acc = out
  }
  const tail = [`trim=duration=${n(plan.totalSec)}`, 'setpts=PTS-STARTPTS']
  if (plan.burnCaptions && assPath) {
    tail.push(`subtitles=${filterPath(assPath)}${fontsDir ? `:fontsdir=${filterPath(fontsDir)}` : ''}`)
  }
  tail.push('format=yuv420p')
  parts.push(`${acc}${tail.join(',')}[vout]`)
  return parts.join(';')
}

/**
 * The audio mix, ending in [amix]. `voiceInput` is an input index and `musicInputs` the
 * music file's input indices (musicInputCount of them), each null when the lane is absent
 * or muted - it is then omitted. With neither, a silent track keeps the file's shape.
 */
export function audioGraph(plan: RenderPlan, voiceInput: number | null, musicInputs: number[] | null): string {
  const total = n(plan.totalSec)
  const parts: string[] = []
  const labels: string[] = []
  if (voiceInput !== null && plan.audio.voice) {
    parts.push(`[${voiceInput}:a]aresample=48000,volume=${n(plan.audio.voice.gainDb)}dB,apad,atrim=0:${total}[voice]`)
    labels.push('[voice]')
  }
  if (musicInputs && musicInputs.length === musicInputCount(plan) && plan.audio.music) {
    parts.push(...musicGraph(plan.audio.music, musicInputs, plan.totalSec))
    labels.push('[music]')
  }
  if (labels.length === 0) {
    parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total}[amix]`)
  } else if (labels.length === 1) {
    parts.push(`${labels[0]}anull[amix]`)
  } else {
    parts.push(`${labels.join('')}amix=inputs=2:normalize=0:duration=longest[amix]`)
  }
  return parts.join(';')
}

/**
 * How many times the worker passes the music file as an input: once for a single pass, twice
 * for Loop to fit - the even passes on one input and the odd on the other, since only
 * neighbouring passes ever overlap (the crossfade is at most half the file). One ffmpeg input
 * per pass would not scale to a long picture, and splitting one input (asplit) into delayed
 * branches stalls the mix in the ffmpeg this worker ships.
 */
export function musicInputCount(plan: RenderPlan): 0 | 1 | 2 {
  const music = plan.audio.music
  if (!music || music.plays.length === 0) return 0
  return music.plays.length > 1 ? 2 : 1
}

/** A pass's gain as an ffmpeg expression of film time t: its crossfades inside it, 0 outside. */
function playGainExpr(play: MusicPlay): string {
  const start = play.startSec
  const end = play.startSec + play.durationSec
  const fadeIn = play.fadeInSec > 0 ? `min(1,(t-${n(start)})/${n(play.fadeInSec)})` : '1'
  const fadeOut = play.fadeOutSec > 0 ? `min(1,(${n(end)}-t)/${n(play.fadeOutSec)})` : '1'
  return `gte(t,${n(start)})*lt(t,${n(end)})*min(${fadeIn},${fadeOut})`
}

/**
 * The music bed, ending in [music] - the film's schedule (buildFilmTimeline), the same one
 * the preview plays. One pass: the file trimmed to the pass. Looped: two streams, each the
 * file padded to two steps and looped (so the even passes land on one and the odd, a step
 * later, on the other), shaped by their passes' crossfades and mixed. Then the mix gain, the
 * duck, the end fade and the film's length.
 */
export function musicGraph(music: NonNullable<RenderPlan['audio']['music']>, inputs: number[], totalSec: number): string[] {
  const total = n(totalSec)
  const parts: string[] = []
  let bed: string
  if (music.plays.length === 1) {
    const play = music.plays[0]
    bed = `[${inputs[0]}:a]aresample=48000,atrim=0:${n(play.durationSec)},asetpts=PTS-STARTPTS,`
  } else {
    const step = music.plays[1].startSec - music.plays[0].startSec
    const period = 2 * step
    const streams = [0, 1].map((parity) => {
      const plays = music.plays.filter((_, k) => k % 2 === parity)
      const offset = parity * step
      const chain = [
        'aresample=48000',
        `apad=whole_dur=${n(period)}`,
        `atrim=0:${n(period)}`,
        `aloop=loop=-1:size=${Math.round(period * 48000)}`,
        `atrim=0:${n(Math.max(0, totalSec - offset))}`,
        'asetpts=N/SR/TB',
        ...(offset > 0 ? [`adelay=delays=${Math.round(offset * 1000)}:all=1`] : []),
        `volume='${plays.map(playGainExpr).join('+')}':eval=frame`,
      ]
      parts.push(`[${inputs[parity]}:a]${chain.join(',')}[mp${parity}]`)
      return `[mp${parity}]`
    })
    bed = `${streams.join('')}amix=inputs=2:normalize=0:duration=longest,`
  }
  const tail = [
    `volume=${n(music.gainDb)}dB`,
    `volume='${duckExpr(music.duck)}':eval=frame`,
    ...(music.endFadeSec > 0 ? [`afade=t=out:st=${n(music.endSec - music.endFadeSec)}:d=${n(music.endFadeSec)}`] : []),
    'apad',
    `atrim=0:${total}`,
  ].join(',')
  parts.push(`${bed}${tail}[music]`)
  return parts
}

export function hasAudio(plan: RenderPlan): boolean {
  return plan.audio.voice !== null || plan.audio.music !== null
}

/** loudnorm's first pass (analysis) - print_format=json on stderr. */
export function loudnessAnalysisFilter(plan: RenderPlan): string {
  const { i, tp, lra } = plan.loudness
  return `[amix]loudnorm=I=${i}:TP=${tp}:LRA=${lra}:print_format=json[aout]`
}

export type LoudnessMeasure = {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/** Reads loudnorm's JSON block from ffmpeg's stderr; null when absent or unusable (e.g. silence). */
export function parseLoudnessMeasure(stderr: string): LoudnessMeasure | null {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const json = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const
    for (const key of keys) if (!Number.isFinite(Number(json[key]))) return null
    return {
      input_i: json.input_i,
      input_tp: json.input_tp,
      input_lra: json.input_lra,
      input_thresh: json.input_thresh,
      target_offset: json.target_offset,
    }
  } catch {
    return null
  }
}

/** loudnorm's second pass with the measured values; a plain resample when nothing was measured. */
export function loudnessFinalFilter(plan: RenderPlan, measured: LoudnessMeasure | null): string {
  if (!measured) return '[amix]aresample=48000[aout]'
  const { i, tp, lra } = plan.loudness
  return (
    `[amix]loudnorm=I=${i}:TP=${tp}:LRA=${lra}` +
    `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}` +
    `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true,aresample=48000[aout]`
  )
}
