import type { ImageState } from './image-state'
import type { AspectRatio } from '@/lib/config/enums'
import { IMAGE_ETA_ESTIMATE_MS, STORYBOARD_IMAGE_SIZES } from '@/lib/config/storyboard'

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

export function laneTotalSeconds(shots: { duration_sec: number | null }[]): number {
  return shots.reduce((sum, s) => sum + shotSeconds(s.duration_sec), 0)
}

export type LaneLayout = { blocks: number[]; contentWidth: number }

// Every block's drawn width, proportional to its duration. Fit is the default: the blocks
// share whatever the lane has left after the gutters and any zero-length blocks. The scale
// is then capped so the longest block never exceeds maxBlockPx - past the cap the timeline
// keeps its proportions and the lane is left partly empty. contentWidth is what the blocks
// and gutters actually occupy, so the ruler and bands can match it.
export function laneLayout(laneWidth: number, seconds: number[], maxBlockPx: number): LaneLayout {
  const gutters = Math.max(0, seconds.length - 1) * LANE_GUTTER_PX
  const zeroCount = seconds.filter((s) => s <= 0).length
  const total = seconds.reduce((sum, s) => sum + Math.max(0, s), 0)
  const longest = Math.max(0, ...seconds)
  const available = Math.max(0, laneWidth - gutters - zeroCount * ZERO_BLOCK_PX)
  const pxPerSecond = total > 0 ? Math.min(available / total, maxBlockPx / longest) : 0
  const blocks = seconds.map((s) => (s > 0 ? s * pxPerSecond : ZERO_BLOCK_PX))
  return { blocks, contentWidth: blocks.reduce((sum, w) => sum + w, 0) + gutters }
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

// Consecutive shots sharing a section_label form one band; a label that recurs after a
// different one starts a new band. Unlabelled shots group the same way, as a nameless band.
export function groupBands(shots: { section_label: string | null; duration_sec: number | null }[]): Band[] {
  const bands: Band[] = []
  shots.forEach((shot, i) => {
    const name = shot.section_label?.trim() ? shot.section_label.trim() : null
    const prev = bands[bands.length - 1]
    if (prev && prev.name === name) {
      prev.seconds += shotSeconds(shot.duration_sec)
    } else {
      bands.push({ name, seconds: shotSeconds(shot.duration_sec), firstIndex: i })
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
// then enough).
export function caseTwo(r: Readiness, balanceCredits: number | null, price: number): CaseTwo | null {
  if (r.notGenerated === 0 || balanceCredits === null) return null
  const requiredCredits = price * r.notGenerated
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
