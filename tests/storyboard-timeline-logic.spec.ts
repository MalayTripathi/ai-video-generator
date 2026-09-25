import { test, expect } from '@playwright/test'
import { IMAGE_ETA_ESTIMATE_MS, RETIME_SNAP_SEC, STORYBOARD_MIN_SHOT_SEC } from '../src/lib/config/storyboard'
import { VIDEO_MODELS, videoModelMaxSeconds } from '../src/lib/config/models'
import {
  blockTier,
  caseTwo,
  etaFor,
  filmOrdered,
  filmSeconds,
  groupBands,
  isRetimeAllowed,
  laneShots,
  orderDiffersFromScript,
  reorderWrites,
  retimeBounds,
  snapRetime,
  LANE_GUTTER_PX,
  laneLayout,
  laneTotalSeconds,
  lockedReason,
  NARROW_SHOT_PX,
  readiness,
  rulerTicks,
  THUMB_FILL_PX,
  thumbBox,
  ZERO_BLOCK_PX,
} from '../src/lib/storyboard/timeline'

// Pure rules behind the Storyboard picture lane (canvas 15a/15c). No browser, no DB.

test.describe('lane geometry', () => {
  test('fit: block widths are proportional to duration_sec and, with the gutters, fill the lane', () => {
    const durations = [5.5, 6, 4.5, 7, 6, 5]
    const total = laneTotalSeconds(durations.map((d) => ({ duration_sec: d })))
    expect(total).toBe(34)
    const lane = 736
    const { blocks, contentWidth } = laneLayout(lane, durations, 10_000)
    const gutters = (durations.length - 1) * LANE_GUTTER_PX
    blocks.forEach((w, i) => expect(w).toBeCloseTo(((lane - gutters) * durations[i]) / total, 6))
    expect(blocks[3] / blocks[2]).toBeCloseTo(7 / 4.5, 6)
    expect(contentWidth).toBeCloseTo(lane, 6)
  })

  test('cap: a short project on a wide lane keeps its proportions and stops at the max block width', () => {
    const durations = [4, 8, 6]
    const { blocks, contentWidth } = laneLayout(2400, durations, 360)
    expect(Math.max(...blocks)).toBeCloseTo(360, 6)
    expect(blocks[0] / blocks[1]).toBeCloseTo(4 / 8, 6)
    expect(blocks[2] / blocks[1]).toBeCloseTo(6 / 8, 6)
    expect(contentWidth).toBeLessThan(2400)
    expect(contentWidth).toBeCloseTo(blocks.reduce((a, b) => a + b, 0) + 2 * LANE_GUTTER_PX, 6)
  })

  test('the cap does not bite when the fitted blocks are already under it', () => {
    const { blocks, contentWidth } = laneLayout(800, [5, 5, 5, 5, 5, 5], 360)
    expect(Math.max(...blocks)).toBeLessThan(360)
    expect(contentWidth).toBeCloseTo(800, 6)
  })

  test('a null or zero duration contributes nothing to the total and draws a minimum block', () => {
    expect(laneTotalSeconds([{ duration_sec: 3 }, { duration_sec: null }, { duration_sec: 0 }])).toBe(3)
    const { blocks, contentWidth } = laneLayout(500, [3, 0], 10_000)
    expect(blocks[1]).toBe(ZERO_BLOCK_PX)
    expect(blocks[0]).toBeCloseTo(500 - LANE_GUTTER_PX - ZERO_BLOCK_PX, 6)
    expect(contentWidth).toBeCloseTo(500, 6)
    expect(laneLayout(500, [0, 0], 360).blocks).toEqual([ZERO_BLOCK_PX, ZERO_BLOCK_PX])
  })

  test('thumbnail box follows the aspect ratio inside the tier square', () => {
    expect(thumbBox('9:16', 52)).toEqual({ width: 29, height: 52 })
    expect(thumbBox('16:9', 52)).toEqual({ width: 52, height: 29 })
    expect(thumbBox('1:1', 52)).toEqual({ width: 52, height: 52 })
    expect(thumbBox('9:16', 28)).toEqual({ width: 16, height: 28 })
    expect(thumbBox('16:9', 28)).toEqual({ width: 28, height: 16 })
  })

  test('narrow threshold: 112px and up is wide, 56 up to 112 narrow, under 56 fill', () => {
    expect(NARROW_SHOT_PX).toBe(112)
    expect(THUMB_FILL_PX).toBe(56)
    expect(blockTier(112)).toBe('wide')
    expect(blockTier(111.9)).toBe('narrow')
    expect(blockTier(56)).toBe('narrow')
    expect(blockTier(55.9)).toBe('fill')
    expect(blockTier(0)).toBe('fill')
  })

  test('the ruler ticks every five seconds and ends on the total', () => {
    expect(rulerTicks(34).map((t) => t.label)).toEqual(['0:00', '0:05', '0:10', '0:15', '0:20', '0:25', '0:30', '0:34'])
    const ticks = rulerTicks(34)
    expect(ticks[1].pct).toBeCloseTo((5 / 34) * 100, 6)
    expect(ticks[ticks.length - 1].pct).toBe(100)
    // A five-second mark within a second of the end is dropped rather than collide.
    expect(rulerTicks(30.5).map((t) => t.label)).toEqual(['0:00', '0:05', '0:10', '0:15', '0:20', '0:25', '0:31'])
  })
})

test.describe('scene bands', () => {
  test('consecutive shots with the same section_label form one band sized by their durations', () => {
    const bands = groupBands([
      { section_label: 'Origins', duration_sec: 5.5 },
      { section_label: 'Origins', duration_sec: 6 },
      { section_label: 'The work', duration_sec: 4.5 },
      { section_label: 'The work', duration_sec: 7 },
      { section_label: 'The work', duration_sec: 6 },
    ])
    expect(bands).toEqual([
      { name: 'Origins', seconds: 11.5, firstIndex: 0 },
      { name: 'The work', seconds: 17.5, firstIndex: 2 },
    ])
  })

  test('a label that recurs after another starts a new band; unlabelled shots group namelessly', () => {
    const bands = groupBands([
      { section_label: 'A', duration_sec: 1 },
      { section_label: 'B', duration_sec: 1 },
      { section_label: 'A', duration_sec: 1 },
      { section_label: null, duration_sec: 2 },
      { section_label: '  ', duration_sec: 3 },
    ])
    expect(bands.map((b) => [b.name, b.seconds])).toEqual([
      ['A', 1],
      ['B', 1],
      ['A', 1],
      [null, 5],
    ])
  })
})

test.describe('readiness, counter and locked reason', () => {
  test('ready counts every frame that has an image, stale included', () => {
    const r = readiness(['ready', 'stale', 'queued', 'generating', 'failed', 'not_generated'])
    expect(r).toEqual({ total: 6, ready: 2, inFlight: 2, failed: 1, notGenerated: 1 })
  })

  test('the locked reason names what is holding the page up, from real readiness', () => {
    expect(lockedReason(readiness(['ready', 'generating', 'queued']))).toBe('two are still drawing')
    expect(lockedReason(readiness(['ready', 'generating']))).toBe('one is still drawing')
    expect(lockedReason(readiness(['ready', 'failed']))).toBe('one has failed')
    expect(lockedReason(readiness(['not_generated', 'not_generated', 'ready']))).toBe("two haven't been generated")
    expect(lockedReason(readiness(['ready', 'stale']))).toBeNull()
  })
})

test.describe('ETA', () => {
  test('a queued frame shows the full estimate and no progress', () => {
    const now = Date.now()
    const iso = new Date(now).toISOString()
    expect(etaFor(iso, iso, now)).toEqual({ pct: 0, label: `~${Math.round(IMAGE_ETA_ESTIMATE_MS / 1000)}s` })
  })

  test('before the page has a clock (server render) a started frame reads as not started', () => {
    expect(etaFor(new Date().toISOString(), null, null)).toEqual({
      pct: 0,
      label: `~${Math.round(IMAGE_ETA_ESTIMATE_MS / 1000)}s`,
    })
  })

  test('a started frame progresses against the estimate constant and never claims 100%', () => {
    const now = Date.now()
    const half = new Date(now - IMAGE_ETA_ESTIMATE_MS / 2).toISOString()
    expect(etaFor(half, null, now)).toEqual({ pct: 50, label: `~${Math.ceil(IMAGE_ETA_ESTIMATE_MS / 2000)}s` })
    const overdue = new Date(now - IMAGE_ETA_ESTIMATE_MS * 3).toISOString()
    expect(etaFor(overdue, null, now)).toEqual({ pct: 95, label: '~1s' })
  })
})

test.describe('case 2 - not enough credits for the last N', () => {
  test('appears only when not-generated frames exist and the balance cannot cover them all', () => {
    const r = readiness(['ready', 'ready', 'ready', 'ready', 'not_generated', 'not_generated'])
    expect(caseTwo(r, 30, 15)).toBeNull()
    expect(caseTwo(r, null, 15)).toBeNull()
    expect(caseTwo(readiness(['ready']), 0, 15)).toBeNull()

    const banner = caseTwo(r, 15, 15)
    expect(banner).toEqual({
      title: 'Not enough credits for the last two frames',
      body: 'Four frames are drawn and kept. Finishing the other two needs 30 credits. You have 15 credits left.',
      requiredCredits: 30,
      shotCount: 2,
    })
  })
})

// Storyboard B2: film order and length sit beside the script's, and win when set.
type LaneShot = {
  id: string
  order_index: number
  film_order: number | null
  duration_sec: number | null
  film_duration_sec: number | null
  binned_at: string | null
}

function laneFixture(n: number): LaneShot[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    order_index: i,
    film_order: null,
    duration_sec: 5,
    film_duration_sec: null,
    binned_at: null,
  }))
}

function applyWrites(shots: LaneShot[], writes: { id: string; film_order: number }[]): LaneShot[] {
  const byId = new Map(writes.map((w) => [w.id, w.film_order]))
  return shots.map((s) => (byId.has(s.id) ? { ...s, film_order: byId.get(s.id)! } : s))
}

test.describe('retime bounds and snap', () => {
  test('the floor is STORYBOARD_MIN_SHOT_SEC and the ceiling is the model maximum', () => {
    const bounds = retimeBounds(5.4, 3)!
    expect(bounds).toEqual({ min: STORYBOARD_MIN_SHOT_SEC, max: 5.4 })
    expect(STORYBOARD_MIN_SHOT_SEC).toBe(1)
    expect(snapRetime(0.2, bounds)).toBe(1)
    expect(snapRetime(9, bounds)).toBe(5.4)
  })

  test('a discrete model caps at its longest allowed value; a continuous one at durationMax', () => {
    expect(videoModelMaxSeconds(VIDEO_MODELS['Kling 2.1'])).toBe(10)
    expect(videoModelMaxSeconds(VIDEO_MODELS['mochi-1'])).toBe(5.4)
  })

  test('a shot already past the ceiling (or under the floor) is never forced back by the bounds', () => {
    expect(retimeBounds(5.4, 6)).toEqual({ min: 1, max: 6 })
    expect(retimeBounds(5.4, 0.8)).toEqual({ min: 0.8, max: 5.4 })
    // A shot with no length yet gets the plain bounds.
    expect(retimeBounds(10, null)).toEqual({ min: 1, max: 10 })
  })

  test('an unknown model leaves retime unavailable', () => {
    expect(retimeBounds(null, 5)).toBeNull()
  })

  test('snaps to 0.1s', () => {
    const bounds = retimeBounds(10, 5)!
    expect(snapRetime(4.5321, bounds)).toBe(4.5)
    expect(snapRetime(5.26, bounds)).toBe(5.3)
    expect(snapRetime(4.5 + RETIME_SNAP_SEC, bounds)).toBe(4.6)
    expect(isRetimeAllowed(5.2, bounds)).toBe(true)
    expect(isRetimeAllowed(5.25, bounds)).toBe(false)
    expect(isRetimeAllowed(0.9, bounds)).toBe(false)
    expect(isRetimeAllowed(10.1, bounds)).toBe(false)
  })
})

test.describe('film order and the bin', () => {
  test('coalesce: film_order wins over order_index, and film_duration_sec over duration_sec', () => {
    const shots = laneFixture(3)
    shots[2].film_order = 0
    shots[0].film_order = 2
    expect(filmOrdered(shots).map((s) => s.id)).toEqual(['s2', 's1', 's0'])
    shots[1].film_duration_sec = 7.5
    expect(filmSeconds(shots[1])).toBe(7.5)
    expect(filmSeconds(shots[0])).toBe(5)
  })

  test('reorderWrites writes only the shots whose position changes, and the result reads back in order', () => {
    const shots = laneFixture(5)
    const writes = reorderWrites(shots, 's3', 1)
    expect(writes).toEqual([
      { id: 's3', film_order: 1 },
      { id: 's1', film_order: 2 },
      { id: 's2', film_order: 3 },
    ])
    const moved = applyWrites(shots, writes)
    expect(laneShots(moved).map((s) => s.id)).toEqual(['s0', 's3', 's1', 's2', 's4'])
    expect(orderDiffersFromScript(moved)).toBe(true)
    // Moving it back restores script order.
    const back = applyWrites(moved, reorderWrites(moved, 's3', 3))
    expect(laneShots(back).map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4'])
    expect(orderDiffersFromScript(back)).toBe(false)
    expect(reorderWrites(shots, 's2', 2)).toEqual([])
  })

  test('a binned shot keeps its slot: reordering around it and restoring puts it back where it was', () => {
    let shots = laneFixture(4)
    shots[1].binned_at = '2026-09-24T10:00:00Z'
    expect(laneShots(shots).map((s) => s.id)).toEqual(['s0', 's2', 's3'])
    // Move s3 to lane position 0.
    shots = applyWrites(shots, reorderWrites(shots, 's3', 0))
    expect(laneShots(shots).map((s) => s.id)).toEqual(['s3', 's0', 's2'])
    shots = shots.map((s) => (s.id === 's1' ? { ...s, binned_at: null } : s))
    // s1 returns right after s0, the shot it followed when it was removed.
    expect(laneShots(shots).map((s) => s.id)).toEqual(['s3', 's0', 's1', 's2'])
  })

  test('the total excludes binned shots and uses the film length', () => {
    const shots = laneFixture(3)
    shots[0].film_duration_sec = 7
    shots[2].binned_at = '2026-09-24T10:00:00Z'
    expect(laneTotalSeconds(shots)).toBe(12)
  })
})
