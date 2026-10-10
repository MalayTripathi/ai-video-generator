import type { FilmTimeline } from '@/lib/storyboard/film'

// A fingerprint of everything a render depends on in the film: the pictures and their
// timing, motion and joins, the audio and its mix, the caption text and the chapters.
// Pure and synchronous (no Web Crypto), so the page computes it live on every edit and the
// server and worker compute it identically. An export whose stored hash differs from the
// page's reads "Edited since". Not a security hash.

const ms = (sec: number) => Math.round(sec * 1000)

function canonical(t: FilmTimeline): string {
  return JSON.stringify([
    t.aspectRatio,
    ms(t.totalSec),
    t.segments.map((s) => [s.shotId, s.part, s.imagePath, s.motion, ms(s.startSec), ms(s.endSec)]),
    t.joins.map((j) => [j.shotId, j.transition, ms(j.dissolveSec)]),
    t.audio.voice
      ? [t.audio.voice.path, t.audio.voice.gainDb, t.audio.voice.pieces.map((p) => [p.shotId, ms(p.fromSec), ms(p.toSec), ms(p.atSec)])]
      : null,
    t.audio.music
      ? [
          t.audio.music.path,
          t.audio.music.gainDb,
          t.audio.music.plays.map((p) => [ms(p.startSec), ms(p.durationSec), ms(p.fadeInSec), ms(p.fadeOutSec)]),
          ms(t.audio.music.endSec),
          ms(t.audio.music.endFadeSec),
        ]
      : null,
    t.audio.duck.map((p) => [ms(p.t), p.db]),
    t.lines.map((l) => [l.text, ms(l.startSec), ms(l.endSec)]),
    (t.words ?? []).map(([a, b]) => [ms(a), ms(b)]),
    t.chapters.map((c) => [c.title, ms(c.startSec)]),
  ])
}

// cyrb53: a fast 53-bit string hash with good dispersion.
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export function filmHash(timeline: FilmTimeline): string {
  const text = canonical(timeline)
  return cyrb53(text).toString(36) + cyrb53(text, 1).toString(36)
}
