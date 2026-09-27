import type { FilmChapter } from '@/lib/storyboard/film'

// Chapters come from the film's section_label scene starts (FilmTimeline.chapters): written
// beside the video as "0:00 Title" lines, and embedded in the mp4 as ffmetadata. Pure.

/** m:ss, or h:mm:ss past an hour - the form video platforms read chapter lists in. */
export function chapterTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export function chaptersTxt(chapters: readonly FilmChapter[]): string {
  return chapters.map((c) => `${chapterTime(c.startSec)} ${c.title}`).join('\n') + (chapters.length ? '\n' : '')
}

function metaEscape(value: string): string {
  return value.replace(/[\\=;#\n]/g, (ch) => (ch === '\n' ? ' ' : `\\${ch}`))
}

/** An ffmetadata file: each chapter runs to the next one's start, the last to the film's end. */
export function chaptersFfmetadata(chapters: readonly FilmChapter[], totalSec: number): string {
  const out = [';FFMETADATA1']
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].startSec : totalSec
    out.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.round(c.startSec * 1000)}`,
      `END=${Math.round(end * 1000)}`,
      `title=${metaEscape(c.title)}`
    )
  })
  return out.join('\n') + '\n'
}
