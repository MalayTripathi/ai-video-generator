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

/** The project's current music, as the film needs it. */
export type FilmMusicSource = {
  path: string
  durationSec: number
  loop: boolean
  muted: boolean
}

/** The music columns the current music is derived from. */
export type MusicColumns = {
  music_path: string | null
  music_duration_sec: number | null
  music_loop: boolean
  music_muted: boolean | null
}

/** The project's current music, or null when there is none. */
export function currentMusic(project: MusicColumns): FilmMusicSource | null {
  if (!project.music_path || project.music_duration_sec === null) return null
  return {
    path: project.music_path,
    durationSec: Number(project.music_duration_sec),
    loop: project.music_loop,
    muted: project.music_muted ?? false,
  }
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
  'aspect_ratio, audio_path, voiceover_generated_at, voiceover_source, voiceover_spans, voiceover_words, total_duration_sec, voiceover_muted, mix_voice_gain_db, mix_music_gain_db, mix_duck_depth_db, mix_duck_bypass, music_muted, music_path, music_duration_sec, music_loop, export_motion, export_transition, caption_mode, caption_style, caption_position, loudness_preset'

export const FILM_SHOT_COLUMNS =
  'id, order_index, film_order, binned_at, duration_sec, film_duration_sec, scenes(title), motion, split_at, split_motion, transition_out, image_path'

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
  music: FilmMusicSource | null
  mix: Omit<StoredMix, 'voiceover_muted' | 'music_muted'>
  settings: Partial<StoredExportSettings>
}): FilmInput {
  const { read, music } = params
  const defaults = resolveFilmDefaults(params.settings)
  return {
    aspectRatio: params.aspectRatio,
    shots: params.shots,
    voiceover: read ? { path: read.audioPath, durationSec: read.durationSec, spans: read.spans, words: read.words } : null,
    music: music ? { path: music.path, durationSec: music.durationSec, loop: music.loop } : null,
    mix: resolveMix({ ...params.mix, voiceover_muted: read?.muted ?? false, music_muted: music?.muted ?? false }),
    defaultMotion: defaults.motion,
    defaultTransition: defaults.transition,
  }
}

/** The film input from database rows (FILM_PROJECT_COLUMNS / FILM_SHOT_COLUMNS). */
export function filmInputFromRows(
  project: VoiceoverColumns &
    MusicColumns &
    StoredExportSettings &
    Omit<StoredMix, 'voiceover_muted' | 'music_muted'> & { aspect_ratio: string | null },
  shots: readonly FilmShot[]
): FilmInput {
  return toFilmInput({
    aspectRatio: projectAspectRatio(project.aspect_ratio),
    shots,
    read: currentRead(project),
    music: currentMusic(project),
    mix: project,
    settings: project,
  })
}
