import type { CaptionPosition } from '@/lib/config/enums'
import { CAPTION_MAX_CHARS_PER_LINE, CAPTION_PAUSE_BREAK_SEC, type CaptionStylePreset } from '@/lib/config/storyboard'
import type { FilmLine } from '@/lib/storyboard/film'
import type { WordBoundary } from '@/lib/storyboard/motion'

// Captions from the voiceover alignment - no extra API cost. voiceover_words holds one
// time range per whitespace-separated token of the script as read (wordBoundaries), and
// the script is the spans' text joined with single spaces, so the spans' tokens pair with
// the words by index. Audio tags ([slowly], [warmly]) take a timing but are never shown.
// Pure.

export type CaptionLine = { text: string; startSec: number; endSec: number }

type TimedWord = { text: string; startSec: number; endSec: number }

const TAG = /\[[^\]]*\]/g

/** The span's tokens as shown: audio tags removed (including multi-token tags), empty tokens dropped, one entry per timing token. */
function displayTokens(text: string): (string | null)[] {
  const out: (string | null)[] = []
  let inTag = false
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    let token = raw
    if (inTag) {
      const close = token.indexOf(']')
      if (close < 0) {
        out.push(null)
        continue
      }
      token = token.slice(close + 1)
      inTag = false
    }
    token = token.replace(TAG, '')
    const open = token.indexOf('[')
    if (open >= 0) {
      token = token.slice(0, open)
      inTag = true
    }
    out.push(token.trim() === '' ? null : token.trim())
  }
  return out
}

function group(words: readonly TimedWord[], maxChars: number, pauseSec: number): CaptionLine[] {
  const lines: CaptionLine[] = []
  let current: TimedWord[] = []
  const flush = () => {
    if (current.length === 0) return
    lines.push({
      text: current.map((w) => w.text).join(' '),
      startSec: current[0].startSec,
      endSec: current[current.length - 1].endSec,
    })
    current = []
  }
  for (const word of words) {
    if (current.length > 0) {
      const length = current.reduce((n, w) => n + w.text.length + 1, 0) + word.text.length
      const pause = word.startSec - current[current.length - 1].endSec
      if (length > maxChars || pause >= pauseSec) flush()
    }
    current.push(word)
  }
  flush()
  return lines
}

/** A span with no usable word timings: split by length, time shared in proportion to characters. */
function spanFallback(line: FilmLine, maxChars: number): CaptionLine[] {
  const tokens = displayTokens(line.text).filter((t): t is string => t !== null)
  const total = tokens.reduce((n, t) => n + t.length + 1, 0)
  if (total === 0) return []
  const perChar = (line.endSec - line.startSec) / total
  let at = line.startSec
  const words = tokens.map((text) => {
    const w = { text, startSec: at, endSec: at + text.length * perChar }
    at += (text.length + 1) * perChar
    return w
  })
  // Pauses cannot be known here, so only the length rule applies.
  return group(words, maxChars, Number.POSITIVE_INFINITY)
}

/**
 * The film's caption lines, in time order. A line breaks before a word that would take it
 * past the character limit, at a pause between words, and at every shot (span) boundary.
 * When the token count does not match the word timings, each span falls back to its own
 * time range.
 */
export function captionLines(
  lines: readonly FilmLine[],
  words: readonly WordBoundary[] | null,
  opts: { maxChars?: number; pauseSec?: number } = {}
): CaptionLine[] {
  const maxChars = opts.maxChars ?? CAPTION_MAX_CHARS_PER_LINE
  const pauseSec = opts.pauseSec ?? CAPTION_PAUSE_BREAK_SEC
  const tokensPerLine = lines.map((l) => displayTokens(l.text))
  const tokenCount = tokensPerLine.reduce((n, t) => n + t.length, 0)
  if (!words || words.length !== tokenCount) return lines.flatMap((l) => spanFallback(l, maxChars))

  const out: CaptionLine[] = []
  let index = 0
  tokensPerLine.forEach((tokens) => {
    const timed: TimedWord[] = []
    for (const token of tokens) {
      const [start, end] = words[index++]
      if (token !== null) timed.push({ text: token, startSec: start, endSec: end })
    }
    out.push(...group(timed, maxChars, pauseSec))
  })
  return out
}

// ---------------------------------------------------------------------------------------
// .srt
// ---------------------------------------------------------------------------------------

function srtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const ms = total % 1000
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(h)}:${two(m)}:${two(s)},${String(ms).padStart(3, '0')}`
}

export function toSrt(lines: readonly CaptionLine[]): string {
  return lines
    .map((line, i) => `${i + 1}\n${srtTime(line.startSec)} --> ${srtTime(line.endSec)}\n${line.text}\n`)
    .join('\n')
}

// ---------------------------------------------------------------------------------------
// ASS (burned in)
// ---------------------------------------------------------------------------------------

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${h}:${two(m)}:${two(s)}.${two(cs % 100)}`
}

function assText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N')
}

export function toAss(
  lines: readonly CaptionLine[],
  style: CaptionStylePreset,
  position: CaptionPosition,
  size: { width: number; height: number }
): string {
  const h = size.height
  const fontSize = Math.max(8, Math.round(h * style.fontSizeFrac))
  const outline = Math.max(1, Math.round(h * style.outlineFrac))
  const shadow = Math.round(h * style.shadowFrac)
  const marginSide = Math.round(size.width * 0.06)
  // Numpad alignment: 2 is bottom centre, 5 is middle centre (where MarginV is ignored).
  const alignment = position === 'middle' ? 5 : 2
  const marginV = position === 'middle' ? 0 : Math.round(h * style.marginFrac)
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${size.width}`,
    `PlayResY: ${size.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${style.font},${fontSize},${style.primary},${style.primary},${style.outline},&H80000000,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginSide},${marginSide},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines.map((l) => `Dialogue: 0,${assTime(l.startSec)},${assTime(l.endSec)},Caption,,0,0,0,,${assText(l.text)}`),
    '',
  ].join('\n')
}
