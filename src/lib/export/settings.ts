import {
  CAPTION_MODES,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  EXPORT_MOTIONS,
  LOUDNESS_PRESETS,
  TRANSITIONS,
  type AspectRatio,
  type CaptionMode,
  type CaptionPosition,
  type CaptionStyle,
  type ExportMotion,
  type LoudnessPreset,
  type Transition,
} from '@/lib/config/enums'
import {
  FILM_DEFAULT_CAPTION_MODE,
  FILM_DEFAULT_CAPTION_POSITION,
  FILM_DEFAULT_CAPTION_STYLE,
  FILM_DEFAULT_LOUDNESS,
  FILM_DEFAULT_MOTION,
  FILM_DEFAULT_TRANSITION,
  LOUDNESS_TARGETS,
} from '@/lib/config/storyboard'
import { MOTION_LABELS, TRANSITION_LABELS } from '@/lib/motion-labels'

// Export settings (canvas 15g): six nullable projects columns, each null meaning the
// storyboard.ts default. The motion and transition defaults are also the film defaults
// every shot with a null motion / transition_out follows. Pure - shared by the page, the
// export routes and the worker.

export const EXPORT_SETTING_COLUMNS = [
  'export_motion',
  'export_transition',
  'caption_mode',
  'caption_style',
  'caption_position',
  'loudness_preset',
] as const
export type ExportSettingColumn = (typeof EXPORT_SETTING_COLUMNS)[number]

/** The columns as stored. Null means the default. */
export type StoredExportSettings = Record<ExportSettingColumn, string | null>

export const EXPORT_SETTING_VALUES: Record<ExportSettingColumn, readonly string[]> = {
  export_motion: EXPORT_MOTIONS,
  export_transition: TRANSITIONS,
  caption_mode: CAPTION_MODES,
  caption_style: CAPTION_STYLES,
  caption_position: CAPTION_POSITIONS,
  loudness_preset: LOUDNESS_PRESETS,
}

/** The settings an export renders with - what an exports row snapshots. */
export type ExportSettings = {
  motion: ExportMotion
  transition: Transition
  captions: CaptionMode
  captionStyle: CaptionStyle
  captionPosition: CaptionPosition
  loudness: LoudnessPreset
  aspectRatio: AspectRatio
}

function pick<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** The film defaults alone - what motion and transition resolution read. */
export function resolveFilmDefaults(stored: Partial<StoredExportSettings>): {
  motion: ExportMotion
  transition: Transition
} {
  return {
    motion: pick(stored.export_motion, EXPORT_MOTIONS, FILM_DEFAULT_MOTION),
    transition: pick(stored.export_transition, TRANSITIONS, FILM_DEFAULT_TRANSITION),
  }
}

/**
 * Project value, else config default, per field. Captions are unavailable without a
 * voiceover, so they resolve to off there whatever is stored.
 */
export function resolveExportSettings(
  stored: Partial<StoredExportSettings>,
  opts: { hasVoiceover: boolean; aspectRatio: AspectRatio }
): ExportSettings {
  const film = resolveFilmDefaults(stored)
  return {
    motion: film.motion,
    transition: film.transition,
    captions: opts.hasVoiceover ? pick(stored.caption_mode, CAPTION_MODES, FILM_DEFAULT_CAPTION_MODE) : 'off',
    captionStyle: pick(stored.caption_style, CAPTION_STYLES, FILM_DEFAULT_CAPTION_STYLE),
    captionPosition: pick(stored.caption_position, CAPTION_POSITIONS, FILM_DEFAULT_CAPTION_POSITION),
    loudness: pick(stored.loudness_preset, LOUDNESS_PRESETS, FILM_DEFAULT_LOUDNESS),
    aspectRatio: opts.aspectRatio,
  }
}

/** Reads an exports.settings snapshot defensively (jsonb); null when it isn't one. */
export function parseExportSettings(raw: unknown): ExportSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const ok = (v: unknown, allowed: readonly string[]) => typeof v === 'string' && allowed.includes(v)
  if (
    !ok(r.motion, EXPORT_MOTIONS) ||
    !ok(r.transition, TRANSITIONS) ||
    !ok(r.captions, CAPTION_MODES) ||
    !ok(r.captionStyle, CAPTION_STYLES) ||
    !ok(r.captionPosition, CAPTION_POSITIONS) ||
    !ok(r.loudness, LOUDNESS_PRESETS) ||
    !ok(r.aspectRatio, ['9:16', '16:9', '1:1'])
  )
    return null
  return r as unknown as ExportSettings
}

export function captionsBurned(mode: CaptionMode): boolean {
  return mode === 'burned' || mode === 'both'
}

export function captionsSrt(mode: CaptionMode): boolean {
  return mode === 'srt' || mode === 'both'
}

// Display labels. Display-only: stored values stay exactly as persisted.
export const EXPORT_MOTION_LABELS: Record<ExportMotion, string> = { alternate: 'Alternate', ...MOTION_LABELS }
export { TRANSITION_LABELS }
export const CAPTION_MODE_LABELS: Record<CaptionMode, string> = {
  off: 'Off',
  srt: '.srt file',
  burned: 'Burned in',
  both: 'Both',
}
export const CAPTION_STYLE_LABELS: Record<CaptionStyle, string> = { reelcraft_default: 'Reelcraft default' }
export const CAPTION_POSITION_LABELS: Record<CaptionPosition, string> = { bottom: 'Bottom', middle: 'Middle' }
export const LOUDNESS_NAMES: Record<LoudnessPreset, string> = {
  streaming: 'Streaming',
  podcast: 'Podcast',
  broadcast: 'Broadcast',
}
export function loudnessLabel(preset: LoudnessPreset): string {
  return `${LOUDNESS_NAMES[preset]} · ${String(LOUDNESS_TARGETS[preset].i).replace('-', '−')} LUFS`
}

// How the summary line and history rows name the captions choice.
const CAPTION_SUMMARY: Record<CaptionMode, string> = {
  off: 'Captions off',
  srt: 'Captions as .srt',
  burned: 'Captions burned in',
  both: 'Captions burned in + .srt',
}

/** The collapsed row's summary: "Alternate motion · Dissolve · Captions off · Streaming loudness". */
export function exportSummary(s: Pick<ExportSettings, 'motion' | 'transition' | 'captions' | 'loudness'>): string {
  return [
    `${EXPORT_MOTION_LABELS[s.motion]} motion`,
    TRANSITION_LABELS[s.transition],
    CAPTION_SUMMARY[s.captions],
    `${LOUDNESS_NAMES[s.loudness]} loudness`,
  ].join(' · ')
}

/** A history row's second line: "Burned-in captions · streaming loudness". */
export function exportRowSummary(s: Pick<ExportSettings, 'captions' | 'loudness'>): string {
  const captions: Record<CaptionMode, string> = {
    off: 'No captions',
    srt: '.srt captions',
    burned: 'Burned-in captions',
    both: 'Burned-in captions and .srt',
  }
  return `${captions[s.captions]} · ${LOUDNESS_NAMES[s.loudness].toLowerCase()} loudness`
}
