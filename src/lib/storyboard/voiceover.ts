import { videoModelBounds, type VideoModelConfig } from '@/lib/config/models'
import { SHOT_DURATION_PAD_SEC } from '@/lib/config/shots'
import { fittedShotSeconds } from '@/lib/shots/durations'
import { filmDuration, filmOrdered, filmPosition, laneShots } from './timeline'

// Pure rules for the Storyboard's voiceover (canvas 15f / 15c c): the script a read is made
// from, the per-shot spans an alignment yields, and the three things spans decide - stale,
// order differs, and Fit to voiceover. No React and no I/O, so each rule is testable alone.

type ScriptShot = {
  id: string
  voice_over: string
  order_index: number
  film_order?: number | null
  binned_at?: string | null
}

/** One in-film shot's character range in the joined script. Empty narration is a zero-length range. */
export type ScriptRange = { shotId: string; from: number; to: number }

export type VoiceoverScript = { text: string; ranges: ScriptRange[] }

/**
 * The script a voiceover reads: every in-film shot's narration (trimmed), in film order,
 * bin excluded, joined with one space. A shot with no narration still gets a range - zero
 * length, at the point it would have started - so every in-film shot has a span.
 */
export function buildScript(shots: readonly ScriptShot[]): VoiceoverScript {
  let text = ''
  const ranges: ScriptRange[] = []
  for (const shot of laneShots(shots)) {
    const part = shot.voice_over.trim()
    if (part === '') {
      ranges.push({ shotId: shot.id, from: text.length, to: text.length })
      continue
    }
    if (text !== '') text += ' '
    const from = text.length
    text += part
    ranges.push({ shotId: shot.id, from, to: text.length })
  }
  return { text, ranges }
}

/** The provider's `alignment` block - per character of the text exactly as sent. */
export type CharacterAlignment = {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

export class AlignmentMismatchError extends Error {
  constructor(detail: string) {
    super(`The alignment does not match the script: ${detail}`)
    this.name = 'AlignmentMismatchError'
  }
}

/**
 * Reads the `alignment` block of a with-timestamps response - never
 * `normalized_alignment`, whose characters are the provider's normalized text (numbers
 * spelled out and so on) and so no longer index the script. The characters must spell
 * the text sent exactly.
 */
export function readAlignment(response: unknown, expectedText: string): CharacterAlignment {
  const alignment = (response as { alignment?: unknown } | null)?.alignment as Partial<CharacterAlignment> | null | undefined
  if (
    !alignment ||
    !Array.isArray(alignment.characters) ||
    !Array.isArray(alignment.character_start_times_seconds) ||
    !Array.isArray(alignment.character_end_times_seconds)
  ) {
    throw new AlignmentMismatchError('no alignment block')
  }
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment
  if (starts.length !== characters.length || ends.length !== characters.length) {
    throw new AlignmentMismatchError('timing arrays differ in length from the characters')
  }
  if (characters.join('') !== expectedText) {
    throw new AlignmentMismatchError('characters do not spell the text sent')
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }
}

/** A slice of the script sent as one request: whole shots only. */
export type ScriptChunk = { from: number; to: number; text: string }

export class ShotTooLongError extends Error {
  readonly shotId: string
  constructor(shotId: string, max: number) {
    super(`One shot's narration is longer than ${max} characters, the most one request can read.`)
    this.name = 'ShotTooLongError'
    this.shotId = shotId
  }
}

/**
 * Splits a script into requests of at most `max` characters, only ever between shots. The
 * single space joining two chunks belongs to neither and is never sent - mergeAlignments
 * puts it back.
 */
export function chunkScript(script: VoiceoverScript, max: number): ScriptChunk[] {
  const chunks: ScriptChunk[] = []
  let current: { from: number; to: number } | null = null
  for (const range of script.ranges) {
    if (range.to === range.from) continue
    if (range.to - range.from > max) throw new ShotTooLongError(range.shotId, max)
    if (current && range.to - current.from <= max) {
      current.to = range.to
      continue
    }
    if (current) chunks.push({ ...current, text: script.text.slice(current.from, current.to) })
    current = { from: range.from, to: range.to }
  }
  if (current) chunks.push({ ...current, text: script.text.slice(current.from, current.to) })
  return chunks
}

/**
 * One alignment for the whole script from each chunk's own. Chunk k's times are offset by
 * the MEASURED audio length of chunks 0..k-1 (not their last character's end - a read can
 * carry trailing silence), matching how the parts are concatenated. The joining spaces
 * take the boundary's time.
 */
export function mergeAlignments(
  text: string,
  chunks: readonly ScriptChunk[],
  alignments: readonly CharacterAlignment[],
  partDurations: readonly number[]
): CharacterAlignment {
  if (alignments.length !== chunks.length || partDurations.length !== chunks.length) {
    throw new AlignmentMismatchError('one alignment and one duration per chunk')
  }
  const characters: string[] = text.split('')
  const starts = new Array<number>(text.length).fill(0)
  const ends = new Array<number>(text.length).fill(0)
  let offset = 0
  let cursor = 0
  chunks.forEach((chunk, k) => {
    const a = alignments[k]
    if (a.characters.join('') !== chunk.text) throw new AlignmentMismatchError(`chunk ${k + 1} does not spell its text`)
    for (; cursor < chunk.from; cursor++) {
      starts[cursor] = offset
      ends[cursor] = offset
    }
    a.characters.forEach((_, i) => {
      starts[chunk.from + i] = a.character_start_times_seconds[i] + offset
      ends[chunk.from + i] = a.character_end_times_seconds[i] + offset
    })
    cursor = chunk.to
    offset += partDurations[k]
  })
  for (; cursor < text.length; cursor++) {
    starts[cursor] = offset
    ends[cursor] = offset
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }
}

/**
 * Maps a forced-alignment result onto the script. That endpoint aligns the audio against
 * the text but may not echo every character back (whitespace, tags), so characters are
 * matched in order; a script character it skipped takes its neighbour's time.
 */
export function alignmentFromForced(text: string, chars: readonly { text: string; start: number; end: number }[]): CharacterAlignment {
  const starts = new Array<number | null>(text.length).fill(null)
  const ends = new Array<number | null>(text.length).fill(null)
  let j = 0
  for (let i = 0; i < text.length && j < chars.length; i++) {
    // Skip provider characters that don't occur here (e.g. extra whitespace) within a small window.
    let k = j
    while (k < chars.length && k < j + 4 && chars[k].text !== text[i]) k++
    if (k < chars.length && chars[k].text === text[i]) {
      starts[i] = chars[k].start
      ends[i] = chars[k].end
      j = k + 1
    }
  }
  if (starts.every((s) => s === null)) throw new AlignmentMismatchError('no character of the script was aligned')
  // Fill gaps from the previous aligned character (or the next one, at the very start).
  let last: number | null = null
  for (let i = 0; i < text.length; i++) {
    if (starts[i] === null) {
      starts[i] = last
      ends[i] = last
    } else last = ends[i]
  }
  const firstStart = starts.find((s) => s !== null) ?? 0
  return {
    characters: text.split(''),
    character_start_times_seconds: starts.map((s) => s ?? firstStart),
    character_end_times_seconds: ends.map((e) => e ?? firstStart),
  }
}

export type VoiceoverSpan = {
  shotId: string
  from: number
  to: number
  /** The shot's narration as read - compared against the current text for staleness. */
  text: string
  startSec: number
  endSec: number
}

/**
 * Per-shot times from a character alignment of `script.text`. A span starts at its first
 * non-space character's start and ends at its last non-space character's end. An empty
 * range takes the previous span's end, so spans stay in time order.
 */
export function buildSpans(script: VoiceoverScript, alignment: CharacterAlignment): VoiceoverSpan[] {
  if (alignment.characters.length !== script.text.length) {
    throw new AlignmentMismatchError('alignment length differs from the script')
  }
  const starts = alignment.character_start_times_seconds
  const ends = alignment.character_end_times_seconds
  let previousEnd = 0
  return script.ranges.map((range) => {
    const text = script.text.slice(range.from, range.to)
    let first = range.from
    while (first < range.to && /\s/.test(script.text[first])) first++
    let last = range.to - 1
    while (last >= first && /\s/.test(script.text[last])) last--
    if (first > last) {
      return { ...range, text, startSec: previousEnd, endSec: previousEnd }
    }
    const span = { ...range, text, startSec: starts[first], endSec: ends[last] }
    previousEnd = span.endSec
    return span
  })
}

/** Reads stored spans defensively - the column is jsonb. */
export function parseSpans(raw: unknown): VoiceoverSpan[] | null {
  if (!Array.isArray(raw)) return null
  const spans: VoiceoverSpan[] = []
  for (const item of raw) {
    const s = item as Partial<VoiceoverSpan> | null
    if (
      !s ||
      typeof s.shotId !== 'string' ||
      typeof s.from !== 'number' ||
      typeof s.to !== 'number' ||
      typeof s.text !== 'string' ||
      typeof s.startSec !== 'number' ||
      typeof s.endSec !== 'number'
    ) {
      return null
    }
    spans.push({ shotId: s.shotId, from: s.from, to: s.to, text: s.text, startSec: s.startSec, endSec: s.endSec })
  }
  return spans
}

type SpanShot = ScriptShot

export type VoiceoverStaleness = {
  stale: boolean
  /** Shots whose narration is in the read but which are now in the bin (or gone). */
  binned: string[]
  /** Shots whose narration text changed since the read. */
  edited: string[]
  /** In-film shots the read has no narration for (restored or added after it was made). */
  missing: string[]
}

/**
 * Computed, never stored: the read describes something no longer on screen. Binning a shot
 * whose narration is in the read makes it stale and restoring the shot clears it; so does
 * an edit to a shot's narration (editing it back clears it); so does an in-film shot the
 * read never covered.
 */
export function voiceoverStaleness(spans: readonly VoiceoverSpan[], shots: readonly SpanShot[]): VoiceoverStaleness {
  const byId = new Map(shots.map((s) => [s.id, s]))
  const inRead = new Set(spans.map((s) => s.shotId))
  const binned: string[] = []
  const edited: string[] = []
  for (const span of spans) {
    const shot = byId.get(span.shotId)
    if (!shot || shot.binned_at) {
      binned.push(span.shotId)
      continue
    }
    if (shot.voice_over.trim() !== span.text) edited.push(span.shotId)
  }
  const missing = laneShots(shots)
    .filter((s) => !inRead.has(s.id))
    .map((s) => s.id)
  return { stale: binned.length + edited.length + missing.length > 0, binned, edited, missing }
}

/** The in-film order of the shots the read covers differs from the order they were read in. */
export function voiceoverOrderDiffers(spans: readonly VoiceoverSpan[], shots: readonly SpanShot[]): boolean {
  const inRead = new Set(spans.map((s) => s.shotId))
  const film = laneShots(shots)
    .map((s) => s.id)
    .filter((id) => inRead.has(id))
  const onFilm = new Set(film)
  const read = spans.map((s) => s.shotId).filter((id) => onFilm.has(id))
  return film.some((id, i) => id !== read[i])
}

/**
 * Restore script order, when a voiceover exists: the film_order writes that put the read's
 * shots back in the order they were read, inside the slots they occupy now - every other
 * shot (the bin, a shot the read doesn't cover) keeps its place.
 */
export function restoreSpanOrderWrites<T extends SpanShot>(
  spans: readonly VoiceoverSpan[],
  shots: readonly T[]
): { id: string; film_order: number }[] {
  const all = filmOrdered(shots)
  const inRead = new Set(spans.map((s) => s.shotId))
  const slots = all.flatMap((s, i) => (!s.binned_at && inRead.has(s.id) ? [i] : []))
  const slotIds = new Set(slots.map((i) => all[i].id))
  const readOrder = spans.map((s) => s.shotId).filter((id) => slotIds.has(id))
  const byId = new Map(all.map((s) => [s.id, s]))
  const next = [...all]
  slots.forEach((slot, k) => {
    next[slot] = byId.get(readOrder[k])!
  })
  return next.flatMap((s, i) => (filmPosition(s) === i ? [] : [{ id: s.id, film_order: i }]))
}

export type FitResult = {
  writes: { id: string; film_duration_sec: number }[]
  /** Every in-film shot's fitted length, in lane order. */
  lengths: { id: string; seconds: number }[]
  /** Shots whose fitted length was clamped to the min or max. */
  clamped: string[]
}

type FitShot = SpanShot & { duration_sec: number | null; film_duration_sec?: number | null }

/**
 * Fit to voiceover. Each narrated in-film shot becomes its spoken span plus padding,
 * rounded up to a length the project's video model can render (whole seconds for a range
 * model, the next allowed value for a discrete one) and kept inside the model's range - so
 * Fit never writes a fractional second. A shot whose speech runs past the model's maximum
 * is clamped there; its narration keeps playing into the next shot (see film.ts's voice
 * pieces). A shot with no narration keeps its own length. Free - it only writes
 * film_duration_sec.
 */
export function fitToVoiceover(spans: readonly VoiceoverSpan[], shots: readonly FitShot[], model: VideoModelConfig): FitResult {
  const lane = laneShots(shots)
  const spanById = new Map(spans.map((s) => [s.shotId, s]))
  const { max } = videoModelBounds(model)
  const lengths: { id: string; seconds: number }[] = []
  const writes: { id: string; film_duration_sec: number }[] = []
  const clamped: string[] = []
  for (const shot of lane) {
    const span = spanById.get(shot.id)
    if (!span || span.to <= span.from || span.endSec <= span.startSec) {
      lengths.push({ id: shot.id, seconds: filmDuration(shot) ?? 0 })
      continue
    }
    const spoken = span.endSec - span.startSec
    const seconds = fittedShotSeconds(spoken, model)
    if (spoken + SHOT_DURATION_PAD_SEC > max + 1e-9) clamped.push(shot.id)
    lengths.push({ id: shot.id, seconds })
    if (filmDuration(shot) !== seconds) writes.push({ id: shot.id, film_duration_sec: seconds })
  }
  return { writes, lengths, clamped }
}

/**
 * Why Fit to voiceover can't run right now, as the copy shown beside it - or null when it
 * can. Order is deliberate: nothing to fit, then out of date, then out of order.
 */
export function fitUnavailableReason(params: {
  hasVoiceover: boolean
  inFlight: boolean
  stale: boolean
  orderDiffers: boolean
}): string | null {
  if (params.inFlight) return 'Wait for the voiceover to finish.'
  if (!params.hasVoiceover) return 'Generate or upload a voiceover first.'
  if (params.stale) return 'The voiceover is out of date. Regenerate it first.'
  if (params.orderDiffers) return 'Picture order differs from the voiceover. Restore script order first.'
  return null
}

export type WaveBar = { h: number; mini: number }

/**
 * The lane's waveform, drawn from the read itself: each bar's height follows how much of
 * its slice of time is speech (from the spans), with a fixed ripple so speech doesn't read
 * as a flat block. Deterministic - the same read always draws the same bars.
 */
export function speechBars(
  spans: readonly Pick<VoiceoverSpan, 'startSec' | 'endSec'>[],
  durationSec: number,
  count: number,
  scale = 20
): WaveBar[] {
  const bars: WaveBar[] = []
  let x = 7
  const slice = durationSec > 0 ? durationSec / count : 0
  for (let i = 0; i < count; i++) {
    x = (x * 1103515245 + 12345) % 2147483648
    const ripple = x / 2147483648
    const t0 = i * slice
    const t1 = t0 + slice
    const speech = spans.reduce((sum, s) => sum + Math.max(0, Math.min(t1, s.endSec) - Math.max(t0, s.startSec)), 0)
    const coverage = slice > 0 ? Math.min(1, speech / slice) : 0
    const h = Math.round(3 + coverage * (1 + scale * (0.35 + 0.65 * ripple)))
    bars.push({ h, mini: Math.max(3, Math.round(h * 0.7)) })
  }
  return bars
}

// Below this gap the voiceover counts as matching the picture: one step of the duration
// stepper, the smallest change retiming can make, so a smaller gap could not be closed.
const LENGTH_TOLERANCE_SEC = 0.1

/** The voiceover runs longer or shorter than the picture by more than one retiming step. */
export function voiceoverLengthDiffers(voiceoverSec: number, pictureSec: number): boolean {
  return Math.abs(voiceoverSec - pictureSec) > LENGTH_TOLERANCE_SEC
}
