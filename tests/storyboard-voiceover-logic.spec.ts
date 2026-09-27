import { test, expect } from '@playwright/test'
import {
  AlignmentMismatchError,
  alignmentFromForced,
  buildScript,
  buildSpans,
  chunkScript,
  fitToVoiceover,
  fitUnavailableReason,
  mergeAlignments,
  readAlignment,
  restoreSpanOrderWrites,
  ShotTooLongError,
  speechBars,
  voiceoverOrderDiffers,
  voiceoverStaleness,
  type VoiceoverSpan,
} from '../src/lib/storyboard/voiceover'
import { stripMp3Headers, concatMp3 } from '../src/lib/voiceover/audio'
import { evenAlignment } from './helpers/voiceover-fakes'

// Pure rules for the Storyboard voiceover (canvas 15f / 15c c). No DB, no network.

type Shot = {
  id: string
  voice_over: string
  order_index: number
  film_order?: number | null
  binned_at?: string | null
  duration_sec: number | null
  film_duration_sec?: number | null
}

function shot(id: string, orderIndex: number, voiceOver: string, extra: Partial<Shot> = {}): Shot {
  return { id, voice_over: voiceOver, order_index: orderIndex, film_order: null, binned_at: null, duration_sec: 3, ...extra }
}

function span(shotId: string, startSec: number, endSec: number, text = 'x', from = 0, to = 1): VoiceoverSpan {
  return { shotId, from, to, text, startSec, endSec }
}

test.describe('buildScript - span building', () => {
  test('joins in-film narration in film order with one space and records each range', () => {
    const shots = [shot('a', 0, 'Hello there.'), shot('b', 1, '  Second line. '), shot('c', 2, 'Third.')]
    const { text, ranges } = buildScript(shots)
    expect(text).toBe('Hello there. Second line. Third.')
    expect(ranges.map((r) => text.slice(r.from, r.to))).toEqual(['Hello there.', 'Second line.', 'Third.'])
  })

  test('follows film order, not script order, and leaves the bin out', () => {
    const shots = [
      shot('a', 0, 'One.', { film_order: 2 }),
      shot('b', 1, 'Two.', { film_order: 0 }),
      shot('c', 2, 'Three.', { film_order: 1, binned_at: '2026-09-25T00:00:00Z' }),
    ]
    const { text, ranges } = buildScript(shots)
    expect(text).toBe('Two. One.')
    expect(ranges.map((r) => r.shotId)).toEqual(['b', 'a'])
  })

  test('a shot with no narration gets a zero-length range and adds no extra space', () => {
    const { text, ranges } = buildScript([shot('a', 0, 'One.'), shot('b', 1, '   '), shot('c', 2, 'Three.')])
    expect(text).toBe('One. Three.')
    expect(ranges[1]).toEqual({ shotId: 'b', from: 4, to: 4 })
    expect(text.slice(ranges[2].from, ranges[2].to)).toBe('Three.')
  })

  test('spans take times from the first to the last non-space character of each range', () => {
    const script = buildScript([shot('a', 0, 'Ab'), shot('b', 1, ''), shot('c', 2, 'Cd')])
    // "Ab Cd": one second per character.
    const alignment = {
      characters: script.text.split(''),
      character_start_times_seconds: [0, 1, 2, 3, 4],
      character_end_times_seconds: [1, 2, 3, 4, 5],
    }
    const spans = buildSpans(script, alignment)
    expect(spans.map((s) => [s.shotId, s.startSec, s.endSec, s.text])).toEqual([
      ['a', 0, 2, 'Ab'],
      ['b', 2, 2, ''],
      ['c', 3, 5, 'Cd'],
    ])
  })
})

test.describe('readAlignment - alignment, never normalized_alignment', () => {
  test('reads the alignment block even when normalized_alignment spells something else', () => {
    const text = 'It cost 5 dollars.'
    const body = {
      alignment: evenAlignment(text),
      normalized_alignment: evenAlignment('It cost five dollars.'),
    }
    const a = readAlignment(body, text)
    expect(a.characters.join('')).toBe(text)
  })

  test('a body with only normalized_alignment is refused, never used as a fallback', () => {
    const text = 'It cost 5 dollars.'
    expect(() => readAlignment({ normalized_alignment: evenAlignment(text) }, text)).toThrow(AlignmentMismatchError)
  })

  test('characters that do not spell the text sent are refused', () => {
    expect(() => readAlignment({ alignment: evenAlignment('Hello') }, 'Hullo')).toThrow(AlignmentMismatchError)
  })
})

test.describe('chunkScript / mergeAlignments', () => {
  test('splits only between shots and never exceeds the limit', () => {
    const script = buildScript([shot('a', 0, 'aaaa'), shot('b', 1, 'bbbb'), shot('c', 2, 'cccc')])
    const chunks = chunkScript(script, 9)
    expect(chunks.map((c) => c.text)).toEqual(['aaaa bbbb', 'cccc'])
    expect(chunks.every((c) => c.text.length <= 9)).toBe(true)
  })

  test('one shot longer than the limit is refused, naming the shot', () => {
    const script = buildScript([shot('a', 0, 'aa'), shot('b', 1, 'bbbbbbbbbbbb')])
    try {
      chunkScript(script, 5)
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ShotTooLongError)
      expect((err as ShotTooLongError).shotId).toBe('b')
    }
  })

  test('later chunks are offset by the measured length of earlier parts, not their last character', () => {
    const script = buildScript([shot('a', 0, 'aa'), shot('b', 1, 'bb')])
    const chunks = chunkScript(script, 2)
    expect(chunks.map((c) => c.text)).toEqual(['aa', 'bb'])
    const partA = { characters: ['a', 'a'], character_start_times_seconds: [0, 1], character_end_times_seconds: [1, 2] }
    const partB = { characters: ['b', 'b'], character_start_times_seconds: [0, 1], character_end_times_seconds: [1, 2] }
    // Part A's audio runs 3.5s (trailing silence) though its last character ends at 2s.
    const merged = mergeAlignments(script.text, chunks, [partA, partB], [3.5, 2])
    expect(merged.characters.join('')).toBe('aa bb')
    expect(merged.character_start_times_seconds).toEqual([0, 1, 3.5, 3.5, 4.5])
    const spans = buildSpans(script, merged)
    expect(spans.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 2],
      [3.5, 5.5],
    ])
  })

  test('forced alignment is mapped onto the script even when it skips characters', () => {
    const text = 'Hi there'
    const chars = [
      { text: 'H', start: 0, end: 0.1 },
      { text: 'i', start: 0.1, end: 0.2 },
      { text: 't', start: 0.5, end: 0.6 },
      { text: 'h', start: 0.6, end: 0.7 },
      { text: 'e', start: 0.7, end: 0.8 },
      { text: 'r', start: 0.8, end: 0.9 },
      { text: 'e', start: 0.9, end: 1.0 },
    ]
    const a = alignmentFromForced(text, chars)
    expect(a.characters.join('')).toBe(text)
    expect(a.character_start_times_seconds[3]).toBe(0.5)
  })
})

test.describe('voiceoverStaleness', () => {
  const shots = [shot('a', 0, 'One.'), shot('b', 1, 'Two.'), shot('c', 2, 'Three.')]
  const spans = [span('a', 0, 1, 'One.'), span('b', 1, 2, 'Two.'), span('c', 2, 3, 'Three.')]

  test('fresh when every in-film shot is read as it stands', () => {
    expect(voiceoverStaleness(spans, shots).stale).toBe(false)
  })

  test('stale when a shot in the read is binned; restoring it clears the staleness', () => {
    const binned = shots.map((s) => (s.id === 'b' ? { ...s, binned_at: '2026-09-25T00:00:00Z' } : s))
    const result = voiceoverStaleness(spans, binned)
    expect(result.stale).toBe(true)
    expect(result.binned).toEqual(['b'])
    const restored = binned.map((s) => (s.id === 'b' ? { ...s, binned_at: null } : s))
    expect(voiceoverStaleness(spans, restored).stale).toBe(false)
  })

  test('stale when a shot’s narration changed; editing it back clears it', () => {
    const edited = shots.map((s) => (s.id === 'a' ? { ...s, voice_over: 'One, changed.' } : s))
    expect(voiceoverStaleness(spans, edited)).toMatchObject({ stale: true, edited: ['a'] })
    expect(voiceoverStaleness(spans, shots).stale).toBe(false)
  })

  test('stale when an in-film shot is not in the read', () => {
    const more = [...shots, shot('d', 3, 'Four.')]
    expect(voiceoverStaleness(spans, more)).toMatchObject({ stale: true, missing: ['d'] })
  })
})

test.describe('voiceoverOrderDiffers / restoreSpanOrderWrites', () => {
  const spans = [span('a', 0, 1), span('b', 1, 2), span('c', 2, 3)]

  test('false in the read order, true once two read shots are swapped', () => {
    const shots = [shot('a', 0, 'x'), shot('b', 1, 'x'), shot('c', 2, 'x')]
    expect(voiceoverOrderDiffers(spans, shots)).toBe(false)
    const swapped = [shot('a', 0, 'x'), shot('b', 1, 'x', { film_order: 2 }), shot('c', 2, 'x', { film_order: 1 })]
    expect(voiceoverOrderDiffers(spans, swapped)).toBe(true)
  })

  test('is measured against the read, not the script: a read made after a reorder is in order', () => {
    const reordered = [shot('a', 0, 'x', { film_order: 1 }), shot('b', 1, 'x', { film_order: 0 }), shot('c', 2, 'x')]
    const readAfter = [span('b', 0, 1), span('a', 1, 2), span('c', 2, 3)]
    expect(voiceoverOrderDiffers(readAfter, reordered)).toBe(false)
  })

  test('restore puts the read’s shots back in read order and the difference is gone', () => {
    const swapped = [shot('a', 0, 'x'), shot('b', 1, 'x', { film_order: 2 }), shot('c', 2, 'x', { film_order: 1 })]
    const writes = restoreSpanOrderWrites(spans, swapped)
    const applied = swapped.map((s) => {
      const w = writes.find((x) => x.id === s.id)
      return w ? { ...s, film_order: w.film_order } : s
    })
    expect(voiceoverOrderDiffers(spans, applied)).toBe(false)
  })
})

test.describe('fitToVoiceover - tiling, snap and clamp', () => {
  test('shots tile the read with no gaps: first from 0, pauses go to the preceding shot, last to the end', () => {
    const shots = [shot('a', 0, 'x'), shot('b', 1, 'x'), shot('c', 2, 'x')]
    // a speaks 0.4-2.0, pause, b speaks 3.0-5.0, c speaks 5.5-7.2; audio runs 8.0s.
    const spans = [span('a', 0.4, 2.0, 'x', 0, 1), span('b', 3.0, 5.0, 'x', 2, 3), span('c', 5.5, 7.2, 'x', 4, 5)]
    const result = fitToVoiceover(spans, shots, 8.0)
    expect(result.lengths.map((l) => l.seconds)).toEqual([3.0, 2.5, 2.5])
    expect(result.lengths.reduce((sum, l) => sum + l.seconds, 0)).toBeCloseTo(8.0, 6)
    expect(result.clamped).toEqual([])
  })

  test('boundaries snap to 0.1s, so lengths stay on the grid and still tile the whole read', () => {
    const shots = [shot('a', 0, 'x'), shot('b', 1, 'x'), shot('c', 2, 'x')]
    const spans = [span('a', 0, 1, 'x', 0, 1), span('b', 1.24, 2, 'x', 2, 3), span('c', 2.38, 3, 'x', 4, 5)]
    const result = fitToVoiceover(spans, shots, 3.42)
    expect(result.lengths.map((l) => l.seconds)).toEqual([1.2, 1.2, 1.0])
    expect(result.lengths.reduce((sum, l) => sum + l.seconds, 0)).toBeCloseTo(3.4, 6)
  })

  test('uses the true spans, past any video model’s clip limit, with nothing clamped', () => {
    const shots = [shot('a', 0, 'x'), shot('b', 1, 'x')]
    const spans = [span('a', 0, 14, 'x', 0, 1), span('b', 14, 20, 'x', 2, 3)]
    const result = fitToVoiceover(spans, shots, 20)
    expect(result.lengths.map((l) => l.seconds)).toEqual([14, 6])
    expect(result.clamped).toEqual([])
  })

  test('lengths clamp only to the minimum and the 30s maximum, and the clamped shots are named', () => {
    const shots = [shot('a', 0, 'x'), shot('b', 1, 'x'), shot('c', 2, 'x')]
    const spans = [span('a', 0, 0.3, 'x', 0, 1), span('b', 0.4, 40, 'x', 2, 3), span('c', 41, 41.5, 'x', 4, 5)]
    const result = fitToVoiceover(spans, shots, 42)
    expect(result.lengths.map((l) => l.seconds)).toEqual([1, 30, 1])
    expect(result.clamped.sort()).toEqual(['a', 'b'])
  })

  test('only shots whose length changes are written', () => {
    const shots = [shot('a', 0, 'x', { duration_sec: 3 }), shot('b', 1, 'x', { duration_sec: 1 })]
    const spans = [span('a', 0, 2, 'x', 0, 1), span('b', 3, 4, 'x', 2, 3)]
    const result = fitToVoiceover(spans, shots, 5)
    expect(result.writes).toEqual([{ id: 'b', film_duration_sec: 2 }])
  })
})

test.describe('fitUnavailableReason', () => {
  const ok = { hasVoiceover: true, inFlight: false, stale: false, orderDiffers: false }

  test('available with a fresh, in-order read', () => {
    expect(fitUnavailableReason(ok)).toBeNull()
  })

  test('unavailable, with a reason, when the read is stale', () => {
    expect(fitUnavailableReason({ ...ok, stale: true })).toMatch(/out of date/)
  })

  test('unavailable, with a reason, when the order differs', () => {
    expect(fitUnavailableReason({ ...ok, orderDiffers: true })).toMatch(/order differs/)
  })

  test('unavailable with no voiceover, or while one is being made', () => {
    expect(fitUnavailableReason({ ...ok, hasVoiceover: false })).not.toBeNull()
    expect(fitUnavailableReason({ ...ok, inFlight: true })).not.toBeNull()
  })
})

test.describe('speechBars', () => {
  test('draws speech taller than silence, deterministically', () => {
    const spans = [span('a', 0, 5)]
    const bars = speechBars(spans, 10, 10)
    expect(bars.slice(0, 5).every((b) => b.h > 3)).toBe(true)
    expect(bars.slice(5).every((b) => b.h === 3)).toBe(true)
    expect(speechBars(spans, 10, 10)).toEqual(bars)
  })
})

test.describe('mp3 joining', () => {
  test('ID3 tags and a Xing/Info frame are stripped before parts are joined; one part is untouched', () => {
    // ID3v2 header with a 4-byte body, then an MPEG-1 L3 128kbps/44.1kHz stereo Info frame
    // (417 bytes), then one audio frame.
    const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4])
    const frame = (tag: string | null) => {
      const f = Buffer.alloc(417)
      f.set([0xff, 0xfb, 0x90, 0x00])
      if (tag) f.write(tag, 36, 'latin1')
      return f
    }
    const part = Buffer.concat([id3, frame('Info'), frame(null)])
    expect(stripMp3Headers(part)).toEqual(frame(null))
    expect(concatMp3([part])).toBe(part)
    expect(concatMp3([part, part])).toEqual(Buffer.concat([frame(null), frame(null)]))
  })
})
