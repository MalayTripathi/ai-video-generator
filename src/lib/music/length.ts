import { MUSIC_MAX_SEC, MUSIC_MIN_SEC } from '@/lib/config/storyboard'

// Pure length rules for the music lane, shared by the generate route (what is requested
// and priced), the card (the price on the button, the warning) and the tests.

/** Seconds a music request asks for: the picture's in-film length now, clamped to the provider's bounds. */
export function requestedMusicSec(pictureSec: number): number {
  const seconds = Number.isFinite(pictureSec) ? Math.round(pictureSec * 10) / 10 : 0
  return Math.min(MUSIC_MAX_SEC, Math.max(MUSIC_MIN_SEC, seconds))
}

// Below this gap the music counts as covering the picture (a sub-frame difference is not
// a shorter piece).
const COVER_EPSILON_SEC = 0.05

/**
 * The shorter-than-picture warning: the picture has outgrown the music and Loop to fit is
 * off. A picture that shrinks never warns - the music fades at the picture's end instead.
 */
export function musicShorterThanPicture(durationSec: number, pictureSec: number, loop: boolean): boolean {
  return !loop && durationSec + COVER_EPSILON_SEC < pictureSec
}
