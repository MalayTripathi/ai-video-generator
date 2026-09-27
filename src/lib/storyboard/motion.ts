import { MOTIONS, TRANSITIONS, type ExportMotion, type Motion, type Transition } from '@/lib/config/enums'
import { ALTERNATE_MOTION_CYCLE, DISSOLVE_SEC, STORYBOARD_MIN_SHOT_SEC } from '@/lib/config/storyboard'
import { filmSeconds } from './timeline'
import { readAlignment, type CharacterAlignment } from './voiceover'

// Pure rules for the Storyboard's Motion & transitions mode (canvas 15d): which motion each
// shot (or split segment) plays, where a split falls, and what each join resolves to. Shared
// by the lane now and by preview and export later. No React and no I/O.

type MotionShot = {
  id: string
  duration_sec: number | null
  film_duration_sec?: number | null
  motion?: string | null
  split_at?: number | null
  split_motion?: string | null
  transition_out?: string | null
}

export function parseMotion(value: unknown): Motion | null {
  return (MOTIONS as readonly unknown[]).includes(value) ? (value as Motion) : null
}

export function parseTransition(value: unknown): Transition | null {
  return (TRANSITIONS as readonly unknown[]).includes(value) ? (value as Transition) : null
}

// ---------------------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------------------

export type SplitBounds = { min: number; max: number }

const EPSILON = 1e-9

/**
 * The fractions a split may take on a shot this long: each segment at least
 * STORYBOARD_MIN_SHOT_SEC. Null when the shot is too short to split at all.
 */
export function splitBounds(seconds: number): SplitBounds | null {
  if (!(seconds > 0) || seconds + EPSILON < 2 * STORYBOARD_MIN_SHOT_SEC) return null
  return { min: STORYBOARD_MIN_SHOT_SEC / seconds, max: 1 - STORYBOARD_MIN_SHOT_SEC / seconds }
}

export function splitUnavailableReason(seconds: number): string | null {
  if (splitBounds(seconds)) return null
  return `Too short to split — each part needs at least ${STORYBOARD_MIN_SHOT_SEC.toFixed(1)}s.`
}

/** A split fraction as stored: three decimals, inside the bounds for this length. Null if unsplittable. */
export function clampSplit(at: number, seconds: number): number | null {
  const bounds = splitBounds(seconds)
  if (!bounds || !Number.isFinite(at)) return null
  const lo = Math.ceil(bounds.min * 1000) / 1000
  const hi = Math.floor(bounds.max * 1000) / 1000
  if (lo > hi) return Math.round(((bounds.min + bounds.max) / 2) * 1000) / 1000
  return Math.min(hi, Math.max(lo, Math.round(at * 1000) / 1000))
}

/** A value a split save may hold for a shot this long. */
export function isSplitAllowed(at: number, seconds: number): boolean {
  const bounds = splitBounds(seconds)
  return !!bounds && Number.isFinite(at) && at > 0 && at < 1 && at >= bounds.min - 1e-6 && at <= bounds.max + 1e-6
}

/**
 * Where a shot's split actually falls now. The stored fraction survives any retime; it is
 * clamped to the current length, and a shot since retimed too short to split plays whole.
 */
export function effectiveSplit(shot: MotionShot): number | null {
  if (shot.split_at === null || shot.split_at === undefined) return null
  const seconds = filmSeconds(shot)
  const bounds = splitBounds(seconds)
  if (!bounds) return null
  return Math.min(bounds.max, Math.max(bounds.min, shot.split_at))
}

// ---------------------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------------------

export type ResolvedMotion = {
  /** The first (or only) segment's motion. */
  motion: Motion
  /** The stored value behind it; null follows the film default. */
  storedMotion: Motion | null
  /** Where the split falls, as a fraction of the shot; null when the shot plays whole. */
  splitAt: number | null
  /** The second segment's motion, when split. */
  splitMotion: Motion | null
  storedSplitMotion: Motion | null
}

/**
 * Every lane shot's motion, in film order. A segment with its own motion plays it; every
 * other segment takes the film default (the project's export motion, else the config
 * default - resolved by the caller). A fixed default is that move everywhere; Alternate is
 * the cycle at the segment's film position, skipping a move equal to the previous
 * segment's, so it never repeats a move on consecutive segments. A split shot is two
 * segments of the same image and counts as two positions.
 */
export function resolveMotions(
  lane: readonly MotionShot[],
  filmDefault: ExportMotion,
  cycle: readonly Motion[] = ALTERNATE_MOTION_CYCLE
): Map<string, ResolvedMotion> {
  const resolved = new Map<string, ResolvedMotion>()
  let previous: Motion | null = null
  let position = 0
  const next = (stored: Motion | null): Motion => {
    let motion = stored
    if (!motion && filmDefault !== 'alternate') motion = filmDefault
    if (!motion) {
      for (let k = 0; k < cycle.length; k++) {
        const candidate = cycle[(position + k) % cycle.length]
        if (candidate !== previous) {
          motion = candidate
          break
        }
      }
      motion ??= cycle[position % cycle.length]
    }
    previous = motion
    position++
    return motion
  }
  for (const shot of lane) {
    const storedMotion = parseMotion(shot.motion)
    const splitAt = effectiveSplit(shot)
    const storedSplitMotion = parseMotion(shot.split_motion)
    const motion = next(storedMotion)
    const splitMotion = splitAt !== null ? next(storedSplitMotion) : null
    resolved.set(shot.id, { motion, storedMotion, splitAt, splitMotion, storedSplitMotion })
  }
  return resolved
}

// ---------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------

/** One spoken word's time range, in seconds from the start of the voiceover. */
export type WordBoundary = readonly [start: number, end: number]

export const FORCED_CUT_REASON = 'Forced to a cut — this join falls inside a spoken word.'

/** Word boundaries from a character alignment: runs of non-space characters. */
export function wordBoundaries(alignment: CharacterAlignment): [number, number][] {
  const words: [number, number][] = []
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment
  let first = -1
  for (let i = 0; i <= characters.length; i++) {
    const space = i === characters.length || /\s/.test(characters[i])
    if (!space && first < 0) first = i
    if (space && first >= 0) {
      words.push([starts[first], ends[i - 1]])
      first = -1
    }
  }
  return words
}

/** Reads projects.voiceover_words defensively - the column is jsonb. Null when absent or malformed. */
export function parseWords(raw: unknown): WordBoundary[] | null {
  if (!Array.isArray(raw)) return null
  const words: WordBoundary[] = []
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'number' || typeof item[1] !== 'number') return null
    words.push([item[0], item[1]])
  }
  return words
}

/**
 * Word boundaries from a stored alignment file's contents ({ text, alignment, spans }, as
 * the voiceover workers write it). Null when the file does not hold a readable alignment.
 */
export function wordsFromStoredAlignment(raw: string): [number, number][] | null {
  try {
    const stored = JSON.parse(raw) as { text?: unknown }
    if (typeof stored?.text !== 'string') return null
    return wordBoundaries(readAlignment(stored, stored.text))
  } catch {
    return null
  }
}

/** True when `atSec` falls strictly inside a spoken word - a join exactly on a word edge is between words. */
export function insideWord(atSec: number, words: readonly WordBoundary[]): boolean {
  return words.some(([start, end]) => start < atSec && atSec < end)
}

export type ResolvedJoin = {
  /** The shot before the join - the one whose transition_out it is. */
  shotId: string
  nextShotId: string
  /** Where the join falls on the film, in seconds. */
  atSec: number
  stored: Transition | null
  /** What the user chose (stored, or the film default). */
  chosen: Transition
  /** What plays. */
  transition: Transition
  /** A dissolve that lands inside a spoken word plays as a cut; the stored value is untouched. */
  forced: boolean
  /** The dissolve's length (0 for a cut), centred on the join. */
  dissolveSec: number
  startSec: number
  endSec: number
}

/**
 * Every join between consecutive lane shots. A dissolve is centred on the join and never
 * changes the film's length; it lasts DISSOLVE_SEC, capped at half the shorter neighbour.
 * A join with no stored transition takes `filmDefault` (the project's, resolved by the caller).
 * With a voiceover (`words` non-null), a dissolve whose join falls inside a spoken word is
 * forced to a cut. With none, nothing is forced.
 */
export function resolveJoins(
  lane: readonly MotionShot[],
  words: readonly WordBoundary[] | null,
  filmDefault: Transition
): ResolvedJoin[] {
  const joins: ResolvedJoin[] = []
  let atSec = 0
  for (let i = 0; i < lane.length - 1; i++) {
    const before = filmSeconds(lane[i])
    const after = filmSeconds(lane[i + 1])
    atSec += before
    const stored = parseTransition(lane[i].transition_out)
    const chosen = stored ?? filmDefault
    const forced = chosen === 'dissolve' && words !== null && insideWord(atSec, words)
    const transition: Transition = forced ? 'cut' : chosen
    const dissolveSec = transition === 'dissolve' ? Math.min(DISSOLVE_SEC, Math.min(before, after) / 2) : 0
    joins.push({
      shotId: lane[i].id,
      nextShotId: lane[i + 1].id,
      atSec,
      stored,
      chosen,
      transition,
      forced,
      dissolveSec,
      startSec: atSec - dissolveSec / 2,
      endSec: atSec + dissolveSec / 2,
    })
  }
  return joins
}

/** A shot's motion as copy: one label, or both segments' joined by a slash when split. */
export function motionSummary(resolved: ResolvedMotion | undefined, labels: Record<Motion, string>): string {
  if (!resolved) return '—'
  const first = labels[resolved.motion]
  return resolved.splitMotion ? `${first} / ${labels[resolved.splitMotion]}` : first
}
