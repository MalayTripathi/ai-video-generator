import { ASPECT_RATIOS, type AspectRatio } from '@/lib/config/enums'
import { resolveMix, type FilmInput, type FilmShot, type StoredMix } from '@/lib/storyboard/film'
import { parseWords, type WordBoundary } from '@/lib/storyboard/motion'
import { parseSpans, type VoiceoverSpan } from '@/lib/storyboard/voiceover'
import { resolveFilmDefaults, type StoredExportSettings } from './settings'

// The one mapping from stored rows to the film timeline's input, shared by the Storyboard
// page (live state), the export routes and the worker (database rows) - so the film the
// page previews and hashes is exactly the film the worker renders. Pure.

/** The project's current voiceover read, as the film needs it. */
export type FilmRead = {
  audioPath: string
  durationSec: number
  spans: VoiceoverSpan[]
  words: WordBoundary[] | null
  muted: boolean
}

/** The voiceover columns a current read is derived from. */
export type VoiceoverColumns = {
  audio_path: string | null
  voiceover_generated_at: string | null
  voiceover_source: string | null
  voiceover_spans: unknown
  voiceover_words?: unknown
  total_duration_sec: number | null
  voiceover_muted: boolean
}

export const FILM_PROJECT_COLUMNS =
  'aspect_ratio, audio_path, voiceover_generated_at, voiceover_source, voiceover_spans, voiceover_words, total_duration_sec, voiceover_muted, mix_voice_gain_db, mix_music_gain_db, mix_duck_depth_db, mix_duck_bypass, music_muted, export_motion, export_transition, caption_mode, caption_style, caption_position, loudness_preset'

export const FILM_SHOT_COLUMNS =
  'id, order_index, film_order, binned_at, duration_sec, film_duration_sec, section_label, motion, split_at, split_motion, transition_out, image_path'

/** The project's aspect ratio, falling back to 9:16 as the Storyboard page does. */
export function projectAspectRatio(value: string | null): AspectRatio {
  return (ASPECT_RATIOS as readonly string[]).includes(value ?? '') ? (value as AspectRatio) : '9:16'
}

/** The project's current read, or null when there is none - the rule the status endpoint uses too. */
export function currentRead(project: VoiceoverColumns): FilmRead | null {
  const spans = parseSpans(project.voiceover_spans)
  if (!project.audio_path || !project.voiceover_generated_at || !spans || !project.voiceover_source) return null
  return {
    audioPath: project.audio_path,
    durationSec: project.total_duration_sec ?? 0,
    spans,
    words: parseWords(project.voiceover_words),
    muted: project.voiceover_muted,
  }
}

export function toFilmInput(params: {
  aspectRatio: AspectRatio
  shots: readonly FilmShot[]
  read: FilmRead | null
  mix: Omit<StoredMix, 'voiceover_muted'>
  settings: Partial<StoredExportSettings>
}): FilmInput {
  const { read } = params
  const defaults = resolveFilmDefaults(params.settings)
  return {
    aspectRatio: params.aspectRatio,
    shots: params.shots,
    voiceover: read ? { path: read.audioPath, durationSec: read.durationSec, spans: read.spans, words: read.words } : null,
    // Music arrives with Storyboard D.
    music: null,
    mix: resolveMix({ ...params.mix, voiceover_muted: read?.muted ?? false }),
    defaultMotion: defaults.motion,
    defaultTransition: defaults.transition,
  }
}

/** The film input from database rows (FILM_PROJECT_COLUMNS / FILM_SHOT_COLUMNS). */
export function filmInputFromRows(
  project: VoiceoverColumns & StoredExportSettings & Omit<StoredMix, 'voiceover_muted'> & { aspect_ratio: string | null },
  shots: readonly FilmShot[]
): FilmInput {
  return toFilmInput({
    aspectRatio: projectAspectRatio(project.aspect_ratio),
    shots,
    read: currentRead(project),
    mix: project,
    settings: project,
  })
}
