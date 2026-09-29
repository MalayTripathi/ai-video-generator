'use client'

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { dbToGain, duckAt, musicEndFadeAt, musicPlayGainAt, type FilmTimeline } from '@/lib/storyboard/film'
import { useStoryboard } from './storyboard-context'

// The one player (canvas 15h): a single clock shared by the timeline playhead, the Preview
// player and the mini player. Its state lives in a small external store, so a tick re-renders
// only what reads the time - never the lane. Audio is Web Audio: the voiceover buffer plays
// through a gain node set from the mix; the music plays each pass of the film's schedule
// (Loop to fit repeats, crossfades) into a bus whose gain follows the mix, the film's
// deterministic duck and the end fade - the same schedule the export renders.

export type PlaybackState = {
  t: number
  playing: boolean
  scrubbing: boolean
  /** The mini player was closed during this play; the next Play clears it. */
  miniClosed: boolean
  /** Whether the Preview player is on screen (IntersectionObserver). */
  previewVisible: boolean
}

type Listener = () => void

class PlaybackEngine {
  state: PlaybackState = {
    t: 0,
    playing: false,
    scrubbing: false,
    miniClosed: false,
    previewVisible: true,
  }
  private listeners = new Set<Listener>()
  private film: FilmTimeline | null = null
  private canPlay = false
  private ctx: AudioContext | null = null
  private voiceGain: GainNode | null = null
  private voiceBuffer: AudioBuffer | null = null
  private voiceSource: AudioBufferSourceNode | null = null
  private voiceUrl: string | null = null
  private voiceLoad = 0
  private musicBus: GainNode | null = null
  private musicBuffer: AudioBuffer | null = null
  private musicSources: { source: AudioBufferSourceNode; gain: GainNode; play: number }[] = []
  private musicUrl: string | null = null
  private musicLoad = 0
  private clockStart = 0
  private clockFrom = 0
  private raf: number | null = null

  subscribe = (listener: Listener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.state

  private set(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }

  // The audio clock while the context runs (so picture and voice stay locked together);
  // the page clock until then - a context can sit suspended until the browser allows sound.
  private audioClock = false

  private now(): number {
    return this.audioClock && this.ctx ? this.ctx.currentTime : performance.now() / 1000
  }

  configure(film: FilmTimeline, canPlay: boolean, voiceUrl: string | null, musicUrl: string | null) {
    const scheduleChanged = !sameMusicSchedule(this.film, film)
    this.film = film
    this.canPlay = canPlay
    if (!canPlay && this.state.playing) this.pause()
    if (this.state.t > film.totalSec) this.set({ t: film.totalSec })
    this.applyGains()
    let restart = false
    if (voiceUrl !== this.voiceUrl) {
      this.voiceUrl = voiceUrl
      this.voiceBuffer = null
      restart = true
      if (this.ctx) void this.loadVoice()
    }
    if (musicUrl !== this.musicUrl) {
      this.musicUrl = musicUrl
      this.musicBuffer = null
      restart = true
      if (this.ctx) void this.loadMusic()
    }
    // A new file, or a new music schedule (loop toggled, picture retimed, mute): replay from
    // the current moment so what sounds is always the current film.
    if (restart || scheduleChanged) {
      this.stopSources()
      if (this.state.playing && !this.state.scrubbing) this.startSources(this.state.t)
    }
  }

  private ensureContext() {
    if (this.ctx) return
    try {
      this.ctx = new AudioContext()
      this.ctx.addEventListener('statechange', () => {
        const running = this.ctx?.state === 'running'
        if (running === this.audioClock) return
        // Re-anchor at the current moment on the new clock.
        const t = this.state.t
        this.audioClock = running
        this.clockStart = this.now()
        this.clockFrom = t
      })
      this.voiceGain = this.ctx.createGain()
      this.voiceGain.connect(this.ctx.destination)
      this.musicBus = this.ctx.createGain()
      this.musicBus.connect(this.ctx.destination)
      this.applyGains()
      void this.loadVoice()
      void this.loadMusic()
    } catch {
      this.ctx = null
    }
  }

  private async loadVoice() {
    const url = this.voiceUrl
    const ctx = this.ctx
    const load = ++this.voiceLoad
    if (!url || !ctx) return
    try {
      const res = await fetch(url)
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer())
      if (load !== this.voiceLoad) return
      this.voiceBuffer = buffer
      // Arrived mid-play: join at the current moment.
      if (this.state.playing && !this.state.scrubbing) this.startSources(this.state.t)
    } catch {
      // No voice audio: the picture still plays, silently.
    }
  }

  private async loadMusic() {
    const url = this.musicUrl
    const ctx = this.ctx
    const load = ++this.musicLoad
    if (!url || !ctx) return
    try {
      const res = await fetch(url)
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer())
      if (load !== this.musicLoad) return
      this.musicBuffer = buffer
      if (this.state.playing && !this.state.scrubbing) this.startSources(this.state.t)
    } catch {
      // No music audio: the film plays without it.
    }
  }

  private applyGains() {
    const voice = this.film?.audio.voice
    if (this.voiceGain) this.voiceGain.gain.value = voice ? dbToGain(voice.gainDb) : 0
    this.applyMusicGains(this.state.t)
  }

  // Set every frame while playing: the bus follows the mix, the duck and the end fade; each
  // pass follows its own crossfades.
  private applyMusicGains(t: number) {
    const music = this.film?.audio.music
    if (this.musicBus) this.musicBus.gain.value = this.musicGainAt(t)
    for (const entry of this.musicSources) {
      const play = music?.plays[entry.play]
      entry.gain.gain.value = play ? musicPlayGainAt(play, t) : 0
    }
  }

  private startSources(t: number) {
    this.stopSources()
    const ctx = this.ctx
    if (!ctx) return
    if (this.voiceGain && this.voiceBuffer && t < this.voiceBuffer.duration) {
      const source = ctx.createBufferSource()
      source.buffer = this.voiceBuffer
      source.connect(this.voiceGain)
      source.start(0, t)
      this.voiceSource = source
    }
    const music = this.film?.audio.music
    if (music && this.musicBus && this.musicBuffer) {
      const buffer = this.musicBuffer
      music.plays.forEach((play, index) => {
        const end = play.startSec + play.durationSec
        if (end <= t) return
        const gain = ctx.createGain()
        gain.connect(this.musicBus!)
        const source = ctx.createBufferSource()
        source.buffer = buffer
        source.connect(gain)
        const offset = Math.max(0, t - play.startSec)
        const length = Math.min(play.durationSec, buffer.duration) - offset
        if (length <= 0) return
        source.start(ctx.currentTime + Math.max(0, play.startSec - t), offset, length)
        this.musicSources.push({ source, gain, play: index })
      })
    }
    this.applyMusicGains(t)
  }

  private stopSources() {
    try {
      this.voiceSource?.stop()
    } catch {
      // already stopped
    }
    this.voiceSource?.disconnect()
    this.voiceSource = null
    for (const { source, gain } of this.musicSources) {
      try {
        source.stop()
      } catch {
        // already stopped or never started
      }
      source.disconnect()
      gain.disconnect()
    }
    this.musicSources = []
  }

  /** The music bus's gain at film time t: its level plus the duck, times the end fade. */
  musicGainAt(t: number): number {
    const music = this.film?.audio.music
    return music ? dbToGain(music.gainDb + duckAt(this.film!.audio.duck, t)) * musicEndFadeAt(music, t) : 0
  }

  play() {
    if (!this.canPlay || !this.film || this.state.playing) return
    this.ensureContext()
    void this.ctx?.resume().catch(() => {})
    this.audioClock = this.ctx?.state === 'running'
    const t = this.state.t >= this.film.totalSec - 1e-3 ? 0 : this.state.t
    this.clockStart = this.now()
    this.clockFrom = t
    this.set({ playing: true, miniClosed: false, t })
    if (!this.state.scrubbing) this.startSources(t)
    this.loop()
  }

  pause() {
    if (!this.state.playing) return
    this.stopSources()
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.set({ playing: false })
  }

  toggle() {
    if (this.state.playing) this.pause()
    else this.play()
  }

  private loop() {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    const tick = () => {
      if (!this.state.playing || !this.film) {
        this.raf = null
        return
      }
      if (!this.state.scrubbing) {
        const t = this.clockFrom + (this.now() - this.clockStart)
        if (t >= this.film.totalSec) {
          this.set({ t: this.film.totalSec })
          this.pause()
          return
        }
        this.set({ t })
        this.applyMusicGains(t)
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /** Moves the time only - never a duration or the order of shots. */
  seek(t: number) {
    const total = this.film?.totalSec ?? 0
    const clamped = Math.max(0, Math.min(total, t))
    this.clockStart = this.now()
    this.clockFrom = clamped
    this.set({ t: clamped })
    if (this.state.playing && !this.state.scrubbing) this.startSources(clamped)
  }

  // While a scrub is held the clock waits and the audio stops; release resumes from there.
  beginScrub() {
    this.stopSources()
    this.set({ scrubbing: true })
  }

  endScrub() {
    this.set({ scrubbing: false })
    this.seek(this.state.t)
  }

  closeMini() {
    this.pause()
    this.set({ miniClosed: true })
  }

  setPreviewVisible(visible: boolean) {
    if (visible !== this.state.previewVisible) this.set({ previewVisible: visible })
  }

  dispose() {
    this.pause()
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.voiceGain = null
    this.musicBus = null
  }
}

// Whether two films play the same music passes - a change (a new file, Loop to fit, a
// retimed picture, mute) restarts the music sources at the current moment.
function sameMusicSchedule(a: FilmTimeline | null, b: FilmTimeline): boolean {
  const x = a?.audio.music ?? null
  const y = b.audio.music
  if (!x || !y) return x === y
  return (
    x.path === y.path &&
    x.endSec === y.endSec &&
    x.plays.length === y.plays.length &&
    x.plays.every((p, i) => p.startSec === y.plays[i].startSec && p.durationSec === y.plays[i].durationSec)
  )
}

const PlaybackContext = createContext<PlaybackEngine | null>(null)

export function usePlaybackEngine(): PlaybackEngine {
  const engine = useContext(PlaybackContext)
  if (!engine) throw new Error('usePlaybackEngine must be used inside PlaybackProvider')
  return engine
}

export function usePlayback(): PlaybackState {
  const engine = usePlaybackEngine()
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot)
}

// Space toggles play anywhere on the step, except while typing in a field.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset'].includes(type)
  }
  return target.closest('[role="textbox"], [contenteditable="true"]') !== null
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const { film, framesReady, voiceover, music } = useStoryboard()
  const [engine] = useState(() => new PlaybackEngine())
  const voiceUrl = voiceover.current?.audioUrl ?? null
  const musicUrl = music.current?.audioUrl ?? null
  useEffect(() => {
    engine.configure(film, framesReady, voiceUrl, musicUrl)
  }, [engine, film, framesReady, voiceUrl, musicUrl])

  useEffect(() => () => engine.dispose(), [engine])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      e.preventDefault()
      engine.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  return <PlaybackContext.Provider value={engine}>{children}</PlaybackContext.Provider>
}
