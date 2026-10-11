import type { ImageState } from './image-state'
import type { AspectRatio } from '@/lib/config/enums'
import { isDurationAllowed, videoModelBounds, type VideoModelConfig } from '@/lib/config/models'
import { nearestModelDuration, stepModelDuration } from '@/lib/shots/durations'
import { effectiveVideoModel } from '@/lib/shots/effective-model'
import { IMAGE_ETA_ESTIMATE_MS, RETIME_SNAP_SEC, STORYBOARD_IMAGE_SIZES, STORYBOARD_MAX_SHOT_SEC, STORYBOARD_MIN_SHOT_SEC } from '@/lib/config/storyboard'

// Pure geometry and copy rules for the Storyboard timeline (canvas 15a/15c). No React, so
// every rule here is testable on its own.

// A block at or above this width shows its name; below it, number + one datum.
export const NARROW_SHOT_PX = 112
// Below this the thumbnail fills the block and the number sits on it.
export const THUMB_FILL_PX = 56
// The boundary gutter between two blocks (a drag grip in Retime mode).
export const LANE_GUTTER_PX = 34
// A shot with no duration still gets a block this wide, so it stays clickable.
export const ZERO_BLOCK_PX = 28
// The square a block's thumbnail fits inside, per tier.
export const THUMB_EDGE_WIDE_PX = 52
export const THUMB_EDGE_NARROW_PX = 28

export type BlockTier = 'wide' | 'narrow' | 'fill'

export function shotSeconds(durationSec: number | null): number {
  return durationSec !== null && durationSec > 0 ? durationSec : 0
}

// The Storyboard's own length and order sit beside the script's and win when set:
// coalesce(film_duration_sec, duration_sec) and coalesce(film_order, order_index). The
// Storyboard never writes the script values.
type FilmTimed = { duration_sec: number | null; film_duration_sec?: number | null }
type FilmOrdered = { order_index: number; film_order?: number | null }
type Binnable = { binned_at?: string | null }

export function filmDuration(shot: FilmTimed): number | null {
  return shot.film_duration_sec ?? shot.duration_sec
}

export function filmSeconds(shot: FilmTimed): number {
  return shotSeconds(filmDuration(shot))
}

export function filmPosition(shot: FilmOrdered): number {
  return shot.film_order ?? shot.order_index
}

// Every shot, binned ones included, in picture order. A tie (possible only if the script
// was re-sequenced after a reorder) falls back to script order, so the result is stable.
export function filmOrdered<T extends FilmOrdered>(shots: readonly T[]): T[] {
  return [...shots].sort((a, b) => filmPosition(a) - filmPosition(b) || a.order_index - b.order_index)
}

// What the timeline draws: picture order, bin excluded. Binned shots keep their film_order,
// so Restore returns one to the slot it left.
export function laneShots<T extends FilmOrdered & Binnable>(shots: readonly T[]): T[] {
  return filmOrdered(shots).filter((s) => !s.binned_at)
}

export function laneTotalSeconds(shots: (FilmTimed & Binnable)[]): number {
  return shots.reduce((sum, s) => sum + (s.binned_at ? 0 : filmSeconds(s)), 0)
}

// The film_order writes that move one lane shot to a new lane position. Positions are
// indices into the full picture order (bin included), which is the same index space as
// order_index - so an unwritten shot's coalesce never collides with a written one. Only
// shots whose position actually changes are written.
export function reorderWrites<T extends FilmOrdered & Binnable & { id: string }>(
  shots: readonly T[],
  shotId: string,
  toLaneIndex: number
): { id: string; film_order: number }[] {
  const all = filmOrdered(shots)
  const lane = all.filter((s) => !s.binned_at)
  const from = lane.findIndex((s) => s.id === shotId)
  if (from < 0) return []
  const to = Math.max(0, Math.min(lane.length - 1, toLaneIndex))
  if (to === from) return []
  const moved = lane[from]
  const rest = all.filter((s) => s.id !== shotId)
  const restLane = lane.filter((s) => s.id !== shotId)
  // Insert before the lane shot now at `to`, or after the last lane shot when moving to the end.
  const anchor = restLane[to]
  const at = anchor ? rest.indexOf(anchor) : rest.indexOf(restLane[restLane.length - 1]) + 1
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)]
  return next.flatMap((s, i) => (filmPosition(s) === i ? [] : [{ id: s.id, film_order: i }]))
}

// True when the lane no longer plays in script order - the order-differs banner's test.
export function orderDiffersFromScript<T extends FilmOrdered & Binnable & { id: string }>(shots: readonly T[]): boolean {
  const film = laneShots(shots).map((s) => s.id)
  const script = [...shots]
    .filter((s) => !s.binned_at)
    .sort((a, b) => a.order_index - b.order_index)
    .map((s) => s.id)
  return film.some((id, i) => id !== script[i])
}

/**
 * The lengths a retime may set. With the project's video model (`model`), only lengths it
 * renders - its allowed values, or its grid inside its range - so a drag or nudge never
 * saves a length clip generation would refuse. Without one (an unregistered model, never
 * expected) the Storyboard's own range on its 0.1s grid.
 */
export type RetimeBounds = { min: number; max: number; model?: VideoModelConfig | null }

// The range a retime may set. With a model it is the model's own lengths, whatever the
// shot holds now - a shot saved at a length the model can't make snaps onto one at its
// first retime. Without one, the range widens to the shot's committed length, so a nudge
// never forces a shot shorter (or longer) than it is.
export function retimeBounds(committedSec: number | null, range: RetimeBounds): RetimeBounds {
  if (range.model) return range
  const committed = committedSec !== null && committedSec > 0 ? committedSec : null
  return {
    min: committed === null ? range.min : Math.min(range.min, committed),
    max: committed === null ? range.max : Math.max(range.max, committed),
  }
}

// The retime range for a project: its video model's shot lengths. A project whose model
// isn't registered (never expected - every write is checked) gets the Storyboard's own
// fallback range rather than another model's.
export function storyboardRetimeRange(videoModel: string | null, shot?: { id: string }): RetimeBounds {
  const config = effectiveVideoModel({ video_model: videoModel }, shot)
  return config ? { ...videoModelBounds(config), model: config } : { min: STORYBOARD_MIN_SHOT_SEC, max: STORYBOARD_MAX_SHOT_SEC }
}

// A dragged length: the nearest one the model renders (or, without a model, 0.1s), clamped.
export function snapRetime(seconds: number, bounds: RetimeBounds): number {
  const clamped = Math.min(bounds.max, Math.max(bounds.min, seconds))
  if (bounds.model) return nearestModelDuration(clamped, bounds.model)
  const steps = Math.round(seconds / RETIME_SNAP_SEC)
  const snapped = Math.round(steps * RETIME_SNAP_SEC * 10) / 10
  return Math.min(bounds.max, Math.max(bounds.min, snapped))
}

// A nudge: the next length the model renders above or below the shot's (Wan 2.5: 5 <-> 10),
// held at the model's edge; without a model, 0.1s.
export function nudgeRetime(committedSec: number | null, direction: 1 | -1, bounds: RetimeBounds): number {
  if (bounds.model) return stepModelDuration(committedSec ?? bounds.min, bounds.model, direction)
  return snapRetime((committedSec ?? 0) + direction * RETIME_SNAP_SEC, bounds)
}

// A value a retime save may hold: one the model renders; without a model, inside the
// bounds and on the 0.1s grid or exactly a bound.
export function isRetimeAllowed(seconds: number, bounds: RetimeBounds): boolean {
  if (!Number.isFinite(seconds)) return false
  if (bounds.model) return isDurationAllowed(bounds.model, seconds)
  if (seconds < bounds.min || seconds > bounds.max) return false
  const onGrid = Math.abs(seconds / RETIME_SNAP_SEC - Math.round(seconds / RETIME_SNAP_SEC)) < 1e-6
  return onGrid || seconds === bounds.min || seconds === bounds.max
}

export type LaneLayout = { blocks: number[]; contentWidth: number; pxPerSecond: number }

// Every block's drawn width, proportional to its duration. Fit is the default: the blocks
// share whatever the lane has left after the gutters and any zero-length blocks, so at Fit
// the timeline fills the lane exactly. contentWidth is what the blocks and gutters occupy,
// so the ruler and bands can match it. A zoom past 1 scales the Fit scale up; the lane then
// scrolls.
export function laneLayout(laneWidth: number, seconds: number[], zoom = 1): LaneLayout {
  const gutters = Math.max(0, seconds.length - 1) * LANE_GUTTER_PX
  const zeroCount = seconds.filter((s) => s <= 0).length
  const total = seconds.reduce((sum, s) => sum + Math.max(0, s), 0)
  const available = Math.max(0, laneWidth - gutters - zeroCount * ZERO_BLOCK_PX)
  const pxPerSecond = total > 0 ? (available / total) * zoom : 0
  const blocks = seconds.map((s) => (s > 0 ? s * pxPerSecond : ZERO_BLOCK_PX))
  return { blocks, contentWidth: blocks.reduce((sum, w) => sum + w, 0) + gutters, pxPerSecond }
}

// A thumbnail's box: the project's aspect ratio fitted inside an edge-by-edge square, so a
// portrait frame is edge tall and a landscape one edge wide. Never a hard-coded ratio.
export function thumbBox(aspectRatio: AspectRatio, edgePx: number): { width: number; height: number } {
  const [w, h] = STORYBOARD_IMAGE_SIZES[aspectRatio].split('x').map(Number)
  return w >= h ? { width: edgePx, height: Math.round((edgePx * h) / w) } : { width: Math.round((edgePx * w) / h), height: edgePx }
}

export function blockTier(px: number): BlockTier {
  if (px >= NARROW_SHOT_PX) return 'wide'
  if (px >= THUMB_FILL_PX) return 'narrow'
  return 'fill'
}

export type Band = { name: string | null; seconds: number; firstIndex: number }

// Consecutive shots sharing a scene title form one band; a title that recurs after a
// different one starts a new band. Shots with no scene group the same way, as a nameless band.
export function groupBands(shots: ({ scenes: { title: string } | null } & FilmTimed)[]): Band[] {
  const bands: Band[] = []
  shots.forEach((shot, i) => {
    const title = shot.scenes?.title?.trim()
    const name = title ? title : null
    const prev = bands[bands.length - 1]
    if (prev && prev.name === name) {
      prev.seconds += filmSeconds(shot)
    } else {
      bands.push({ name, seconds: filmSeconds(shot), firstIndex: i })
    }
  })
  return bands
}

export function formatTimecode(seconds: number): string {
  const whole = Math.round(seconds)
  const m = Math.floor(whole / 60)
  const s = whole % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export type Tick = { label: string; pct: number }

// Every five seconds from zero, plus the end. A five-second mark within a second of the
// end is dropped so the two labels never collide.
export function rulerTicks(totalSeconds: number): Tick[] {
  if (totalSeconds <= 0) return [{ label: '0:00', pct: 0 }]
  const ticks: Tick[] = []
  for (let t = 0; t < totalSeconds - 1; t += 5) {
    ticks.push({ label: formatTimecode(t), pct: (t / totalSeconds) * 100 })
  }
  ticks.push({ label: formatTimecode(totalSeconds), pct: 100 })
  return ticks
}

export type Readiness = {
  total: number
  ready: number
  inFlight: number
  failed: number
  notGenerated: number
}

// "Ready" means an image exists - a stale image is still a frame on the timeline.
export function readiness(states: ImageState[]): Readiness {
  const r: Readiness = { total: states.length, ready: 0, inFlight: 0, failed: 0, notGenerated: 0 }
  for (const state of states) {
    if (state === 'ready' || state === 'stale') r.ready++
    else if (state === 'queued' || state === 'generating') r.inFlight++
    else if (state === 'failed') r.failed++
    else r.notGenerated++
  }
  return r
}

export function isInFlight(state: ImageState): boolean {
  return state === 'queued' || state === 'generating'
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

export function countWord(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n)
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Why Preview & mix is still locked, from real readiness. Drawing wins over failed wins
// over not generated - the clause names what is actually holding the page up. Null once
// every frame is ready.
export function lockedReason(r: Readiness): string | null {
  if (r.ready === r.total) return null
  if (r.inFlight > 0) return `${countWord(r.inFlight)} ${r.inFlight === 1 ? 'is' : 'are'} still drawing`
  if (r.failed > 0) return `${countWord(r.failed)} ${r.failed === 1 ? 'has' : 'have'} failed`
  return `${countWord(r.notGenerated)} ${r.notGenerated === 1 ? "hasn't" : "haven't"} been generated`
}

export type Eta = { pct: number; label: string }

// Progress and ETA for an in-flight block. Nothing reports real progress, so both come from
// the claim's start time against a fixed estimate; a queued block has not started. A null
// `now` (before the page has a clock - the server render) reads as not started.
export function etaFor(startedAt: string | null, queuedAt: string | null, now: number | null): Eta {
  if (queuedAt !== null || startedAt === null || now === null) {
    return { pct: 0, label: `~${Math.round(IMAGE_ETA_ESTIMATE_MS / 1000)}s` }
  }
  const elapsed = Math.max(0, now - new Date(startedAt).getTime())
  const pct = Math.min(95, Math.round((elapsed / IMAGE_ETA_ESTIMATE_MS) * 100))
  const remaining = Math.max(1, Math.ceil((IMAGE_ETA_ESTIMATE_MS - elapsed) / 1000))
  return { pct, label: `~${remaining}s` }
}

export type CaseTwo = { title: string; body: string; requiredCredits: number; shotCount: number }

// Canvas 15c (d): some frames were never generated and the balance can't cover all of them.
// Null when there is nothing to finish or the balance covers it (the per-block Generate is
// then enough). `requiredCredits` is the not-generated frames' prices summed - each frame is
// priced on its own references.
export function caseTwo(r: Readiness, balanceCredits: number | null, requiredCredits: number): CaseTwo | null {
  if (r.notGenerated === 0 || balanceCredits === null) return null
  if (balanceCredits >= requiredCredits) return null
  const frames = (n: number) => (n === 1 ? 'frame' : 'frames')
  const drawn =
    r.ready === 0
      ? 'No frames are drawn yet.'
      : `${capitalise(countWord(r.ready))} ${frames(r.ready)} ${r.ready === 1 ? 'is' : 'are'} drawn and kept.`
  const other = r.notGenerated === 1 ? 'the other one' : `the other ${countWord(r.notGenerated)}`
  return {
    title: `Not enough credits for the last ${countWord(r.notGenerated)} ${frames(r.notGenerated)}`,
    body: `${drawn} Finishing ${other} needs ${requiredCredits} ${requiredCredits === 1 ? 'credit' : 'credits'}. You have ${balanceCredits} ${balanceCredits === 1 ? 'credit' : 'credits'} left.`,
    requiredCredits,
    shotCount: r.notGenerated,
  }
}

// The transport's time, to a tenth of a second (canvas 15h: "0:11.4").
export function formatPlayTime(seconds: number): string {
  const tenths = Math.max(0, Math.floor(seconds * 10 + 1e-6))
  const m = Math.floor(tenths / 600)
  const s = (tenths % 600) / 10
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
