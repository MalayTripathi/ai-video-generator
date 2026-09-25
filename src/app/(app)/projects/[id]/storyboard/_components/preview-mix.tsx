'use client'

import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { AspectRatio } from '@/lib/config/enums'
import { MIX_STEP_DB, PREVIEW_PLAYER_SIZES } from '@/lib/config/storyboard'
import { formatDb, MIX_RANGES, resolveMix, snapMixDb, type MixColumn } from '@/lib/storyboard/film'
import { formatTimecode } from '@/lib/storyboard/timeline'
import { useStoryboard } from './storyboard-context'
import { usePlayback, usePlaybackEngine } from './playback-context'
import { FilmPicture, useNowLine } from './film-picture'
import { PauseIcon, PlayIcon } from './timeline-card'

/** The player's box for a ratio (canvas 15i). 16:9 fills the section; its height follows the ratio. */
export function previewBoxStyle(aspectRatio: AspectRatio): CSSProperties {
  const size = PREVIEW_PLAYER_SIZES[aspectRatio]
  return size.width !== null && size.height !== null
    ? { width: size.width, height: size.height }
    : { width: '100%', aspectRatio: '16 / 9' }
}

type DbField = Exclude<MixColumn, 'mix_duck_bypass'>

// One mix slider: drag or arrow keys set it, double-click resets it to its default.
function MixSlider({ field, label }: { field: DbField; label: string }) {
  const { mix, setMixField, readOnly } = useStoryboard()
  const range = MIX_RANGES[field]
  const stored = mix[field]
  const value = stored ?? range.default
  const pct = ((value - range.min) / (range.max - range.min)) * 100
  const track = useRef<HTMLSpanElement>(null)

  const valueAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return value
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return snapMixDb(range.min + f * (range.max - range.min), range)
  }

  const set = (next: number) => {
    if (next !== value) setMixField(field, next)
  }

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (readOnly || e.button !== 0 || e.detail > 1) return
    e.preventDefault()
    e.currentTarget.focus()
    set(valueAt(e.clientX))
    const move = (ev: globalThis.PointerEvent) => set(valueAt(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (readOnly) return
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? MIX_STEP_DB
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -MIX_STEP_DB
          : 0
    if (delta === 0) return
    e.preventDefault()
    set(snapMixDb(value + delta, range))
  }

  return (
    <div className="flex items-center gap-[12px]">
      <span className="w-[88px] flex-none text-small text-text-secondary">{label}</span>
      <span
        ref={track}
        role="slider"
        tabIndex={readOnly ? -1 : 0}
        aria-label={label}
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        aria-valuenow={value}
        aria-valuetext={formatDb(value)}
        aria-disabled={readOnly}
        data-testid={`mix-slider-${field}`}
        data-default={stored === null ? 'true' : 'false'}
        title="Double-click to reset"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => !readOnly && stored !== null && setMixField(field, null)}
        className={`relative flex h-[18px] min-w-0 flex-1 touch-none items-center rounded-badge outline-none focus-visible:ring-2 focus-visible:ring-border-strong-hover ${
          readOnly ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
        }`}
      >
        <span className="block h-[3px] w-full rounded-[2px] bg-bg-inset" />
        <span className="absolute left-0 h-[3px] rounded-[2px] bg-border-strong-hover" style={{ width: `${pct}%` }} />
        <span
          className="absolute ml-[-5px] h-[11px] w-[11px] rounded-full border border-border-strong-hover bg-bg-canvas"
          style={{ left: `${pct}%` }}
        />
      </span>
      <span className="w-[64px] flex-none text-right font-mono text-mono text-text-tertiary tabular-nums">{formatDb(value)}</span>
    </div>
  )
}

function BypassDucking() {
  const { mix, setMixField, readOnly } = useStoryboard()
  const on = mix.mix_duck_bypass ?? false
  return (
    <div className="flex items-center gap-[9px]">
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-label="Bypass ducking"
        data-testid="mix-bypass"
        disabled={readOnly}
        onClick={() => setMixField('mix_duck_bypass', !on)}
        className="flex h-[13px] w-[13px] flex-none cursor-pointer items-center justify-center rounded-[3px] border border-border-strong bg-bg-surface text-text-primary disabled:cursor-not-allowed"
      >
        {on && (
          <svg width="9" height="7" viewBox="0 0 9 7" fill="none" aria-hidden="true">
            <path d="M1 3.5 3.3 5.8 8 1" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        )}
      </button>
      <span className="flex-1 text-small text-text-secondary">Bypass ducking</span>
      <span className="text-meta text-text-tertiary">Changing the mix is free and marks nothing stale.</span>
    </div>
  )
}

// Preview & mix (canvas 15b / 15i): the player sized by the project's ratio, the line being
// spoken, and the mix. The playhead is shared with the timeline.
export function PreviewMix() {
  const { aspectRatio, film, voiceover, mix, mixError, resetMix, readOnly } = useStoryboard()
  const engine = usePlaybackEngine()
  const { t, playing } = usePlayback()
  const line = useNowLine()
  const player = useRef<HTMLDivElement>(null)
  const wide = aspectRatio === '16:9'
  const anySet =
    mix.mix_voice_gain_db !== null ||
    mix.mix_music_gain_db !== null ||
    mix.mix_duck_depth_db !== null ||
    mix.mix_duck_bypass !== null

  // The mini player shows only while this player is off-screen.
  useEffect(() => {
    const el = player.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => engine.setPreviewVisible(entry.isIntersecting), { threshold: 0.25 })
    observer.observe(el)
    return () => {
      observer.disconnect()
      engine.setPreviewVisible(true)
    }
  }, [engine])

  const resolved = resolveMix({
    ...mix,
    voiceover_muted: voiceover.current?.muted ?? false,
  })

  return (
    <div data-testid="preview-mix" className="flex flex-none flex-col gap-[12px]">
      <div className="flex items-baseline gap-[12px]">
        <span className="text-screen font-medium tracking-snug">Preview &amp; mix</span>
        <span className="flex-1 text-meta text-text-tertiary">
          Watch it back with the mix applied. The playhead is shared with the timeline.
        </span>
      </div>
      <div
        className={`flex items-stretch gap-rc-md rounded-frame border border-border-subtle bg-bg-surface p-[14px] ${wide ? 'flex-col' : 'flex-row'}`}
      >
        <div
          className="flex flex-none flex-col gap-[9px]"
          style={wide ? undefined : { width: previewBoxStyle(aspectRatio).width }}
        >
          <div ref={player} data-testid="preview-player" style={previewBoxStyle(aspectRatio)}>
            <FilmPicture testId="preview-picture" className="h-full w-full rounded-control border border-border-subtle" />
          </div>
          <div className="flex items-center gap-[10px]">
            <button
              type="button"
              data-testid="preview-play"
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
              onClick={() => engine.toggle()}
              className="flex h-[28px] w-[28px] flex-none cursor-pointer items-center justify-center rounded-full border border-border-strong text-text-primary hover:border-accent hover:text-accent"
            >
              {playing ? <PauseIcon size={8} /> : <PlayIcon size={8} />}
            </button>
            <span data-testid="preview-time" className="font-mono text-mono text-text-tertiary tabular-nums">
              {formatTimecode(Math.floor(Math.min(t, film.totalSec)))} / {formatTimecode(film.totalSec)}
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-[12px]">
          <div className="flex flex-col gap-[3px] border-l-2 border-ident-voiceover-fg py-[1px] pl-[10px]">
            <span className="text-label uppercase tracking-label text-ident-voiceover-fg">Voiceover · Now</span>
            <span data-testid="voiceover-now" className="text-small leading-[1.5] text-text-secondary">
              {!voiceover.current
                ? 'No voiceover. The film plays silent.'
                : resolved.voiceMuted
                  ? 'The voiceover is muted.'
                  : (line ?? 'The narration shows here as it plays.')}
            </span>
          </div>
          <div className="flex flex-col gap-[11px] rounded-control border border-border-subtle bg-bg-canvas p-[12px_14px]">
            <div className="flex items-center gap-[10px]">
              <span className="flex-1 text-label uppercase tracking-label text-text-tertiary">Mix</span>
              <span className="text-meta text-text-tertiary">double-click a slider to reset it</span>
              <button
                type="button"
                data-testid="mix-reset"
                disabled={readOnly || !anySet}
                onClick={() => resetMix()}
                className="flex h-[24px] cursor-pointer items-center rounded-control border border-border-subtle px-[9px] text-small text-text-secondary hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                Reset mix
              </button>
            </div>
            <MixSlider field="mix_voice_gain_db" label="Voiceover" />
            <MixSlider field="mix_music_gain_db" label="Music bed" />
            <MixSlider field="mix_duck_depth_db" label="Duck depth" />
            <BypassDucking />
            {mixError && (
              <span role="alert" className="text-small text-status-failed-fg">
                {mixError}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
