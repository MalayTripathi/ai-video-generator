import type { AspectRatio, ExportMotion, Motion, Transition } from '@/lib/config/enums'
import {
  DUCK_ATTACK_SEC,
  DUCK_RELEASE_SEC,
  MIX_DUCK_DEPTH_DB,
  MIX_MUSIC_GAIN_DB,
  MIX_STEP_DB,
  MIX_VOICE_GAIN_DB,
  MOTION_PAN_PCT,
  MOTION_PAN_SCALE,
  MOTION_ZOOM,
  MUSIC_END_FADE_SEC,
  MUSIC_LOOP_CROSSFADE_SEC,
  type MixRange,
} from '@/lib/config/storyboard'
import { resolveJoins, resolveMotions, type ResolvedJoin, type WordBoundary } from './motion'
import { filmSeconds, groupBands, laneShots } from './timeline'
import type { VoiceoverSpan } from './voiceover'

// The one film timeline (Storyboard E): what plays, when, and how it sounds. The client
// player reads it now and the export worker renders from it, so preview and export can
// never disagree. Pure - no React, no I/O, nothing browser- or Next-specific.

// ---------------------------------------------------------------------------------------
// Mix
// ---------------------------------------------------------------------------------------

export type Mix = {
  voiceGainDb: number
  musicGainDb: number
  duckDepthDb: number
  duckBypass: boolean
  voiceMuted: boolean
  musicMuted: boolean
}

/** The project columns the mix is stored in. Null means the storyboard.ts default. */
export type StoredMix = {
  mix_voice_gain_db: number | null
  mix_music_gain_db: number | null
  mix_duck_depth_db: number | null
  mix_duck_bypass: boolean | null
  music_muted: boolean | null
  voiceover_muted: boolean
}

export const MIX_COLUMNS = ['mix_voice_gain_db', 'mix_music_gain_db', 'mix_duck_depth_db', 'mix_duck_bypass'] as const
export type MixColumn = (typeof MIX_COLUMNS)[number]

export const MIX_RANGES: Record<'mix_voice_gain_db' | 'mix_music_gain_db' | 'mix_duck_depth_db', MixRange> = {
  mix_voice_gain_db: MIX_VOICE_GAIN_DB,
  mix_music_gain_db: MIX_MUSIC_GAIN_DB,
  mix_duck_depth_db: MIX_DUCK_DEPTH_DB,
}

function inRange(value: number | null, range: MixRange): number {
  return value !== null && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : range.default
}

export function resolveMix(stored: StoredMix): Mix {
  return {
    voiceGainDb: inRange(stored.mix_voice_gain_db, MIX_VOICE_GAIN_DB),
    musicGainDb: inRange(stored.mix_music_gain_db, MIX_MUSIC_GAIN_DB),
    duckDepthDb: inRange(stored.mix_duck_depth_db, MIX_DUCK_DEPTH_DB),
    duckBypass: stored.mix_duck_bypass ?? false,
    voiceMuted: stored.voiceover_muted,
    musicMuted: stored.music_muted ?? false,
  }
}

/** A slider value as stored: on the MIX_STEP_DB grid, inside its range. */
export function snapMixDb(value: number, range: MixRange): number {
  const snapped = Math.round(value / MIX_STEP_DB) * MIX_STEP_DB
  return Math.min(range.max, Math.max(range.min, Math.round(snapped * 10) / 10))
}

export function isMixDbAllowed(value: number, range: MixRange): boolean {
  return Number.isFinite(value) && value >= range.min && value <= range.max && snapMixDb(value, range) === value
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

export function formatDb(db: number): string {
  const text = Math.abs(db).toFixed(1)
  return db < 0 ? `−${text} dB` : `${text} dB`
}

// ---------------------------------------------------------------------------------------
// Ducking
// ---------------------------------------------------------------------------------------

/** One breakpoint of the music's duck, in dB relative to its gain; linear between points. */
export type DuckPoint = { t: number; db: number }

export type DuckOptions = {
  depthDb: number
  bypass: boolean
  attackSec?: number
  releaseSec?: number
}

/**
 * The music's duck from the word timings: full depth across each spoken word, reached over
 * the attack before it and released over the release after it. Words whose ramps would
 * overlap merge into one held region, so the music never pumps between close words.
 * Bypassed (or zero depth, or no words), the envelope is empty.
 */
export function duckEnvelope(words: readonly WordBoundary[] | null, options: DuckOptions): DuckPoint[] {
  const attack = options.attackSec ?? DUCK_ATTACK_SEC
  const release = options.releaseSec ?? DUCK_RELEASE_SEC
  if (options.bypass || options.depthDb === 0 || !words || words.length === 0) return []
  const sorted = [...words].filter(([s, e]) => e >= s).sort((a, b) => a[0] - b[0])
  const regions: { start: number; end: number }[] = []
  for (const [start, end] of sorted) {
    const prev = regions[regions.length - 1]
    if (prev && start - attack <= prev.end + release) prev.end = Math.max(prev.end, end)
    else regions.push({ start, end })
  }
  return regions.flatMap(({ start, end }) => [
    { t: start - attack, db: 0 },
    { t: start, db: options.depthDb },
    { t: end, db: options.depthDb },
    { t: end + release, db: 0 },
  ])
}

/** The duck at `t`, in dB (0 = not ducked). */
export function duckAt(points: readonly DuckPoint[], t: number): number {
  if (points.length === 0 || t <= points[0].t || t >= points[points.length - 1].t) return 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (t <= b.t) return b.t === a.t ? b.db : a.db + ((b.db - a.db) * (t - a.t)) / (b.t - a.t)
  }
  return 0
}

// ---------------------------------------------------------------------------------------
// Motion as a transform
// ---------------------------------------------------------------------------------------

/** How the still is drawn: scaled about its centre, then offset by a percentage of the frame. */
export type FrameTransform = { scale: number; xPct: number; yPct: number }

/** One motion at `progress` (0-1 across the segment's visible time). Linear, so it renders identically everywhere. */
export function motionTransform(motion: Motion, progress: number): FrameTransform {
  const p = Math.min(1, Math.max(0, progress))
  const half = MOTION_PAN_PCT / 2
  const lerp = (a: number, b: number) => a + (b - a) * p
  switch (motion) {
    case 'push_in':
      return { scale: lerp(1, MOTION_ZOOM), xPct: 0, yPct: 0 }
    case 'pull_out':
      return { scale: lerp(MOTION_ZOOM, 1), xPct: 0, yPct: 0 }
    // The camera pans left, so the picture slides right across the frame (and so on).
    case 'pan_left':
      return { scale: MOTION_PAN_SCALE, xPct: lerp(-half, half), yPct: 0 }
    case 'pan_right':
      return { scale: MOTION_PAN_SCALE, xPct: lerp(half, -half), yPct: 0 }
    case 'pan_up':
      return { scale: MOTION_PAN_SCALE, xPct: 0, yPct: lerp(-half, half) }
    case 'pan_down':
      return { scale: MOTION_PAN_SCALE, xPct: 0, yPct: lerp(half, -half) }
    case 'static':
      return { scale: 1, xPct: 0, yPct: 0 }
  }
}

// ---------------------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------------------

export type FilmShot = {
  id: string
  order_index: number
  film_order?: number | null
  binned_at?: string | null
  duration_sec: number | null
  film_duration_sec?: number | null
  section_label: string | null
  motion?: string | null
  split_at?: number | null
  split_motion?: string | null
  transition_out?: string | null
  image_path: string | null
}

export type FilmSegment = {
  shotId: string
  /** The shot's position on the film (0-based). */
  shotIndex: number
  /** 'b' is a split shot's second segment - the same image, its own motion. */
  part: 'a' | 'b'
  imagePath: string | null
  motion: Motion
  /** The segment's own time on the film. */
  startSec: number
  endSec: number
  /** When it is on screen: widened by half a dissolve at each dissolve join, so the two shots overlap. */
  showFromSec: number
  showToSec: number
}

export type FilmLine = {
  shotId: string
  text: string
  startSec: number
  endSec: number
}
export type FilmChapter = { title: string; startSec: number }

export type FilmVoiceover = {
  path: string
  durationSec: number
  spans: readonly VoiceoverSpan[]
  words: readonly WordBoundary[] | null
}

/**
 * One pass of the music file through the film: it starts at startSec, plays the file from
 * its beginning for durationSec, fading in over fadeInSec and out over fadeOutSec (the
 * crossfade into the next pass). Every pass but the first fades in; every pass with a
 * successor fades out.
 */
export type MusicPlay = {
  startSec: number
  durationSec: number
  fadeInSec: number
  fadeOutSec: number
}

export type FilmMusic = {
  path: string
  durationSec: number
  gainDb: number
  /** Loop to fit in effect: set, and the music shorter than the picture. */
  looping: boolean
  plays: MusicPlay[]
  /** Where the music ends: the picture's end, or its own end when it is shorter and not looped. */
  endSec: number
  /** The fade-out ending at endSec, over the whole music bus. */
  endFadeSec: number
}

/**
 * Where the music plays against a picture of totalSec. Looped (Loop to fit, and only when
 * the music is shorter than the picture): repeats that overlap by a crossfade until the
 * picture ends. Otherwise one pass. Either way the music fades out ending at endSec - the
 * picture's end when the music is at least as long (a picture that shrank after the music
 * was made), or its own end when it is shorter and not looped.
 */
export function musicSchedule(
  durationSec: number,
  totalSec: number,
  loop: boolean
): Pick<FilmMusic, 'looping' | 'plays' | 'endSec' | 'endFadeSec'> {
  const dur = Math.max(0, durationSec)
  const total = Math.max(0, totalSec)
  const looping = loop && dur > 0 && dur < total
  const plays: MusicPlay[] = []
  let endSec: number
  if (looping) {
    const crossfade = Math.min(MUSIC_LOOP_CROSSFADE_SEC, dur / 2)
    const step = dur - crossfade
    for (let k = 0, start = 0; start < total; k++, start = k * step) {
      const hasNext = start + dur < total
      plays.push({
        startSec: start,
        durationSec: Math.min(dur, total - start),
        fadeInSec: k > 0 ? crossfade : 0,
        fadeOutSec: hasNext ? crossfade : 0,
      })
    }
    endSec = total
  } else {
    endSec = Math.min(dur, total)
    if (endSec > 0) plays.push({ startSec: 0, durationSec: endSec, fadeInSec: 0, fadeOutSec: 0 })
  }
  return { looping, plays, endSec, endFadeSec: Math.min(MUSIC_END_FADE_SEC, endSec / 2) }
}

/** One pass's own gain (0..1) at film time t: its crossfades, zero outside the pass. */
export function musicPlayGainAt(play: MusicPlay, t: number): number {
  const local = t - play.startSec
  if (local < 0 || local >= play.durationSec) return 0
  let g = 1
  if (play.fadeInSec > 0 && local < play.fadeInSec) g = Math.min(g, local / play.fadeInSec)
  const fromEnd = play.durationSec - local
  if (play.fadeOutSec > 0 && fromEnd < play.fadeOutSec) g = Math.min(g, fromEnd / play.fadeOutSec)
  return g
}

/** The end fade's gain (0..1) at film time t, over the whole music bus. */
export function musicEndFadeAt(music: Pick<FilmMusic, 'endSec' | 'endFadeSec'>, t: number): number {
  if (t >= music.endSec) return 0
  const fadeStart = music.endSec - music.endFadeSec
  if (music.endFadeSec <= 0 || t <= fadeStart) return 1
  return (music.endSec - t) / music.endFadeSec
}

/**
 * The music's own gain (0..1) at film time t from its schedule, before the mix gain and the
 * duck: the overlapping passes' crossfades, times the end fade. The preview sets its gains
 * from these same functions; the export renders the same breakpoints with afade.
 */
export function musicEnvelopeAt(music: Pick<FilmMusic, 'plays' | 'endSec' | 'endFadeSec'>, t: number): number {
  if (t < 0) return 0
  const passes = music.plays.reduce((sum, p) => sum + musicPlayGainAt(p, t), 0)
  return Math.min(1, passes * musicEndFadeAt(music, t))
}

export type FilmTimeline = {
  aspectRatio: AspectRatio
  totalSec: number
  segments: FilmSegment[]
  joins: ResolvedJoin[]
  audio: {
    /** Omitted (null) when there is no voiceover or its lane is muted. */
    voice: { path: string; durationSec: number; gainDb: number } | null
    /** Omitted (null) when there is no music or its lane is muted. */
    music: FilmMusic | null
    duck: DuckPoint[]
  }
  lines: FilmLine[]
  words: readonly WordBoundary[] | null
  chapters: FilmChapter[]
}

export type FilmInput = {
  aspectRatio: AspectRatio
  shots: readonly FilmShot[]
  voiceover: FilmVoiceover | null
  music?: { path: string; durationSec: number; loop: boolean } | null
  mix: Mix
  /** The film defaults a shot's null motion / transition_out follows (resolveExportSettings). */
  defaultMotion: ExportMotion
  defaultTransition: Transition
}

export function buildFilmTimeline(input: FilmInput): FilmTimeline {
  const lane = laneShots(input.shots)
  const words = input.voiceover?.words ?? null
  const motions = resolveMotions(lane, input.defaultMotion)
  const joins = resolveJoins(lane, words, input.defaultTransition)

  const segments: FilmSegment[] = []
  let at = 0
  lane.forEach((shot, i) => {
    const seconds = filmSeconds(shot)
    const resolved = motions.get(shot.id)!
    const lead = i > 0 ? joins[i - 1].dissolveSec / 2 : 0
    const trail = i < joins.length ? joins[i].dissolveSec / 2 : 0
    const start = at
    const end = at + seconds
    const base = { shotId: shot.id, shotIndex: i, imagePath: shot.image_path }
    if (resolved.splitAt !== null && resolved.splitMotion !== null) {
      const cut = start + seconds * resolved.splitAt
      segments.push({
        ...base,
        part: 'a',
        motion: resolved.motion,
        startSec: start,
        endSec: cut,
        showFromSec: start - lead,
        showToSec: cut,
      })
      segments.push({
        ...base,
        part: 'b',
        motion: resolved.splitMotion,
        startSec: cut,
        endSec: end,
        showFromSec: cut,
        showToSec: end + trail,
      })
    } else {
      segments.push({
        ...base,
        part: 'a',
        motion: resolved.motion,
        startSec: start,
        endSec: end,
        showFromSec: start - lead,
        showToSec: end + trail,
      })
    }
    at = end
  })

  const vo = input.voiceover
  const mix = input.mix
  const lines = (vo?.spans ?? [])
    .filter((s) => s.text.trim().length > 0 && s.endSec > s.startSec)
    .map((s) => ({
      shotId: s.shotId,
      text: s.text.trim(),
      startSec: s.startSec,
      endSec: s.endSec,
    }))

  const bands = groupBands(lane)
  const chapters: FilmChapter[] = []
  let bandAt = 0
  for (const band of bands) {
    if (band.name) chapters.push({ title: band.name, startSec: bandAt })
    bandAt += band.seconds
  }

  const music: FilmMusic | null =
    input.music && !mix.musicMuted && at > 0
      ? {
          path: input.music.path,
          durationSec: input.music.durationSec,
          gainDb: mix.musicGainDb,
          ...musicSchedule(input.music.durationSec, at, input.music.loop),
        }
      : null

  return {
    aspectRatio: input.aspectRatio,
    totalSec: at,
    segments,
    joins,
    audio: {
      voice:
        vo && !mix.voiceMuted
          ? {
              path: vo.path,
              durationSec: vo.durationSec,
              gainDb: mix.voiceGainDb,
            }
          : null,
      music,
      duck: duckEnvelope(words, {
        depthDb: mix.duckDepthDb,
        bypass: mix.duckBypass,
      }),
    },
    lines,
    words,
    chapters,
  }
}

export type FilmLayer = {
  segment: FilmSegment
  opacity: number
  transform: FrameTransform
}

/**
 * What is on screen at `t`, bottom layer first. Inside a dissolve the outgoing shot stays
 * fully opaque and the incoming one fades in over it - the same linear blend ffmpeg's
 * xfade=fade renders. Motion progresses across each segment's on-screen time.
 */
export function visualsAt(timeline: FilmTimeline, t: number): FilmLayer[] {
  if (timeline.segments.length === 0) return []
  const time = Math.min(Math.max(0, t), Math.max(0, timeline.totalSec - 1e-6))
  const layers: FilmLayer[] = []
  for (const segment of timeline.segments) {
    if (time < segment.showFromSec || time >= segment.showToSec) continue
    const span = segment.showToSec - segment.showFromSec
    const progress = span > 0 ? (time - segment.showFromSec) / span : 0
    // Fading in: the incoming side of a dissolve, before its own start.
    const fade = segment.showFromSec < segment.startSec && time < segment.startSec + (segment.startSec - segment.showFromSec)
    const opacity = fade ? (time - segment.showFromSec) / (2 * (segment.startSec - segment.showFromSec)) : 1
    layers.push({
      segment,
      opacity: Math.min(1, Math.max(0, opacity)),
      transform: motionTransform(segment.motion, progress),
    })
  }
  return layers
}

/**
 * The "Voiceover · Now" line at `t`: the narration holding the current word - the word
 * being spoken, or the last one spoken. Before the first word there is no line.
 */
export function lineAt(timeline: FilmTimeline, t: number): FilmLine | null {
  const { lines, words } = timeline
  if (lines.length === 0) return null
  let wordStart: number | null = null
  if (words && words.length > 0) {
    for (const [start] of words) {
      if (start <= t) wordStart = start
      else break
    }
  } else {
    for (const line of lines) if (line.startSec <= t) wordStart = line.startSec
  }
  if (wordStart === null) return null
  let found: FilmLine | null = null
  for (const line of lines) {
    if (line.startSec <= wordStart + 1e-6) found = line
  }
  return found
}
