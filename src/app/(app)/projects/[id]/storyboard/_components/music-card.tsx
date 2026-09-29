'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { InsufficientCreditsBanner } from '@/components/insufficient-credits-banner'
import { PromptConfirmModal, type PromptConfirmContent } from '@/components/prompt-confirm-modal'
import { parseRailFigures, useRailFigures } from '@/components/rail-figures-context'
import { Spinner } from '@/components/spinner'
import { createClient as createBrowserSupabase } from '@/lib/supabase/client'
import { creditsFor } from '@/lib/config/credits'
import {
  MUSIC_ETA_BASE_MS,
  MUSIC_ETA_MS_PER_SEC,
  MUSIC_STYLE_PROMPT_EDIT_MAX_CHARS,
  MUSIC_UPLOAD_FORMATS,
  MUSIC_UPLOAD_MAX_BYTES,
  MUSIC_UPLOAD_MAX_SEC,
} from '@/lib/config/storyboard'
import { formatClockTime } from '@/lib/format-clock-time'
import { formatCredits } from '@/lib/format-credits'
import { musicShorterThanPicture, requestedMusicSec } from '@/lib/music/length'
import { formatTimecode } from '@/lib/storyboard/timeline'
import { removeMusic, saveMusicStylePrompt, setMusicLoop, setMusicMuted } from '../actions'
import { useStoryboard } from './storyboard-context'
import { useNow } from './use-now'

// The Music card under the Voiceover card (canvas 15f, StoryboardFrame pass 2): empty,
// generating, failed, present and shorter-than-picture, each with a collapsed line of fixed
// height and an expanded card. Generating is paid and runs in the background; the lane learns
// the outcome from the page's one status poll. Everything else here is free. A paid click
// shows only a pending control until the server accepts (202) - the balance gate answers
// first, so a 402 leaves the card exactly as it was.

export function musicPrice(pictureSec: number): number {
  return creditsFor({ step: 'storyboard', operation: 'background_music', quantity: requestedMusicSec(pictureSec) })
}

const EXT_MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }
const ACCEPT = Object.keys(MUSIC_UPLOAD_FORMATS).join(',')
const PLACEHOLDER = 'Instruments, mood and tempo — for example, soft piano and strings, hopeful, slow'

function uploadMime(file: File): string | null {
  if (MUSIC_UPLOAD_FORMATS[file.type]) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? null
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

function secondsPhrase(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds))
  if (whole >= 60) return formatTimecode(whole)
  const word = NUMBER_WORDS[whole] ?? String(whole)
  return `${word} ${whole === 1 ? 'second' : 'seconds'}`
}

/** The shorter-than-picture warning, from seconds. */
export function shorterMessage(durationSec: number, pictureSec: number): string {
  return `Music is ${formatTimecode(durationSec)} — ${secondsPhrase(pictureSec - durationSec)} shorter than the picture. It will fade out early unless you loop or extend it.`
}

// A still, decorative waveform - the music has no timings to draw from. Seeded, so it is the
// same bars on every render of the same file.
function musicBars(seed: string, count: number): number[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  const bars: number[] = []
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    const r = ((h >>> 0) % 1000) / 1000
    const swell = 0.55 + 0.45 * Math.sin((i / count) * Math.PI)
    bars.push(Math.round(5 + r * 13 * swell))
  }
  return bars
}

type CardView = 'empty' | 'generating' | 'failed' | 'present' | 'short'

type CardError =
  | { kind: 'credits'; requiredCredits: number; balanceCredits: number | null }
  | { kind: 'error'; message: string }

type Confirm = { content: PromptConfirmContent; credits: number; run: () => void }

function noSubscribe(): () => void {
  return () => {}
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Remembering the card's state is a convenience; without storage it simply resets.
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  return (await res.json().catch(() => null)) as Record<string, unknown> | null
}

function PlayGlyph({ playing }: { playing: boolean }) {
  return playing ? (
    <svg width="8" height="9" viewBox="0 0 8 9" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="2.2" height="7" fill="currentColor" />
      <rect x="4.8" y="1" width="2.2" height="7" fill="currentColor" />
    </svg>
  ) : (
    <svg width="8" height="9" viewBox="0 0 8 9" fill="none" aria-hidden="true">
      <path d="M1 1 7 4.5 1 8z" fill="currentColor" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="9" height="6" viewBox="0 0 9 6" fill="none" aria-hidden="true" className={`flex-none ${open ? 'rotate-180' : ''}`}>
      <path d="M1 1.25 4.5 4.75 8 1.25" className="stroke-text-tertiary" strokeWidth="1.3" />
    </svg>
  )
}

function Ident() {
  return (
    <span className="flex flex-none items-center gap-[8px]">
      <span className="h-[13px] w-[2px] rounded-[1px] bg-border-strong" />
      <span className="text-label uppercase tracking-label text-text-tertiary">Music</span>
    </span>
  )
}

function Price({ credits }: { credits: number }) {
  return <span className="font-mono text-mono font-normal text-text-tertiary">{formatCredits(credits)} cr</span>
}

const SMALL_BUTTON =
  'flex h-[26px] flex-none cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-control border border-border-subtle px-[9px] text-small leading-none text-text-secondary hover:border-border-strong hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60'

const LOOP_BUTTON =
  'flex h-[26px] flex-none cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-control border border-sb-warn-line px-[10px] text-small leading-none text-sb-warn-title hover:bg-sb-warn-bg-hover disabled:cursor-not-allowed disabled:opacity-60'

function PlayButton({ playing, onClick }: { playing: boolean; onClick: () => void }) {
  const label = playing ? 'Pause music' : 'Play music alone'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-full border border-border-strong text-text-primary hover:border-accent hover:text-accent"
    >
      <PlayGlyph playing={playing} />
    </button>
  )
}

export function MusicCard({ initialStylePrompt }: { initialStylePrompt: string | null }) {
  const { projectId, readOnly, film, music, refreshStatus } = useStoryboard()
  const { setFigures } = useRailFigures()
  const current = music.current
  const pictureSec = film.totalSec
  const price = musicPrice(pictureSec)

  // The style prompt: the field's text, and what the server holds (saved on blur).
  const [prompt, setPrompt] = useState(initialStylePrompt ?? '')
  const savedPrompt = useRef(initialStylePrompt ?? '')
  const [deriving, setDeriving] = useState(false)
  const derivationAsked = useRef(false)

  const [submitting, setSubmitting] = useState<'generate' | 'upload' | null>(null)
  const [accepted, setAccepted] = useState<{ seconds: number } | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<CardError | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [mutedOverride, setMutedOverride] = useState<{ key: string; value: boolean } | null>(null)
  const [loopOverride, setLoopOverride] = useState<{ key: string; value: boolean } | null>(null)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const muteKey = `${current?.generatedAt ?? ''}:${current?.muted ?? false}`
  const isMuted = mutedOverride?.key === muteKey ? mutedOverride.value : (current?.muted ?? false)
  const loopKey = `${current?.generatedAt ?? ''}:${current?.loop ?? false}`
  const isLooped = loopOverride?.key === loopKey ? loopOverride.value : (current?.loop ?? false)

  const inFlight = accepted !== null || music.state === 'generating'
  const short = !!current && musicShorterThanPicture(current.durationSec, pictureSec, isLooped)
  const view: CardView = inFlight
    ? 'generating'
    : choosing
      ? 'empty'
      : music.state === 'failed'
        ? 'failed'
        : !current
          ? 'empty'
          : short
            ? 'short'
            : 'present'

  // Open or closed is remembered per project; the card opens once when a run fails, so the
  // message is seen - after that the person's collapse is respected.
  const openKey = `reelcraft.storyboard.musicOpen.${projectId}`
  const seenKey = `reelcraft.storyboard.musicSeen.${projectId}`
  const storedOpen = useSyncExternalStore(noSubscribe, () => readStored(openKey), () => null)
  const storedSeen = useSyncExternalStore(noSubscribe, () => readStored(seenKey), () => null)
  const [openChoice, setOpenChoice] = useState<boolean | null>(null)
  const attention = view === 'failed' ? `failed:${music.failedAt}` : null
  const [seenChoice, setSeenChoice] = useState<string | null>(null)
  const unseen = attention !== null && attention !== (seenChoice ?? storedSeen)
  const open = unseen || (openChoice ?? storedOpen === '1')

  // The style prompt is derived the first time the person expands the card while the field
  // is empty - never on render. The server's claim makes it once per project; this ref only
  // keeps one tab from asking twice.
  const derive = useCallback(async () => {
    if (readOnly || derivationAsked.current || savedPrompt.current.trim() !== '') return
    derivationAsked.current = true
    setDeriving(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/music/prompt`, { method: 'POST' })
      const body = await readJson(res)
      const derived = res.ok && typeof body?.prompt === 'string' ? body.prompt : null
      // Only into a field the person hasn't started typing in.
      if (derived) {
        savedPrompt.current = derived
        setPrompt((prev) => (prev.trim() === '' ? derived : prev))
      }
    } catch {
      // On failure the field stays empty with its placeholder; nothing retries on its own.
    } finally {
      setDeriving(false)
    }
  }, [projectId, readOnly])

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenChoice(next)
      writeStored(openKey, next ? '1' : '0')
      if (attention) {
        setSeenChoice(attention)
        writeStored(seenKey, attention)
      }
      if (next && prompt.trim() === '') void derive()
    },
    [openKey, seenKey, attention, prompt, derive]
  )

  const savePrompt = useCallback(async () => {
    if (readOnly) return
    const next = prompt.replace(/\s+/g, ' ').trim()
    if (next === savedPrompt.current.trim()) return
    const result = await saveMusicStylePrompt(projectId, next).catch(() => ({ success: false }) as const)
    if (result.success) {
      savedPrompt.current = next
      setError(null)
    } else {
      setError({ kind: 'error', message: "The style prompt couldn't be saved. Try again." })
    }
  }, [projectId, prompt, readOnly])

  // ▶ plays the music alone, the file as it is.
  const togglePlay = useCallback(() => {
    const src = current?.audioUrl
    if (!src) return
    let audio = audioRef.current
    if (!audio) {
      audio = new Audio()
      audio.onended = () => setPlaying(false)
      audioRef.current = audio
    }
    if (playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    if (audio.src !== src) audio.src = src
    void audio.play().then(
      () => setPlaying(true),
      () => setPlaying(false)
    )
  }, [current?.audioUrl, playing])
  useEffect(() => () => audioRef.current?.pause(), [])

  const startGenerateRef = useRef<((credits: number) => Promise<void>) | null>(null)

  const startGenerate = useCallback(
    async (credits: number) => {
      if (readOnly || submitting) return
      setError(null)
      // The prompt as typed is what this run uses: save it first if it changed.
      await savePrompt()
      setSubmitting('generate')
      let started = false
      try {
        const res = await fetch(`/api/projects/${projectId}/music`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedCredits: credits }),
        })
        const body = await readJson(res)
        const rail = parseRailFigures(body?.rail)
        if (rail) setFigures(rail)
        if (res.ok) {
          started = true
          setAccepted({ seconds: requestedMusicSec(pictureSec) })
          setChoosing(false)
        } else if (res.status === 402) {
          setError({
            kind: 'credits',
            requiredCredits: Number(body?.requiredCredits ?? 0),
            balanceCredits: typeof body?.balanceCredits === 'number' ? body.balanceCredits : null,
          })
        } else if (res.status === 409 && body?.code === 'price_changed' && typeof body.credits === 'number') {
          const next = body.credits
          setConfirm({
            content: {
              title: 'The price changed',
              body: 'The picture’s length changed since this page loaded, so this costs a different amount now.',
              quote: null,
              confirmLabel: 'Continue',
            },
            credits: next,
            run: () => void startGenerateRef.current?.(next),
          })
        } else if (res.status === 409 && body?.code === 'in_flight') {
          setError({ kind: 'error', message: 'Music is already being made. It will appear here when it lands.' })
        } else if (res.status === 422 && typeof body?.error === 'string') {
          setError({ kind: 'error', message: body.error })
        } else {
          setError({ kind: 'error', message: "The music couldn't be started. Try again." })
        }
      } catch {
        setError({ kind: 'error', message: "The music couldn't be started. Try again." })
      } finally {
        // A refused request leaves the card as it was at once; an accepted one holds
        // Generating until the status poll has the run.
        if (!started) setSubmitting(null)
        await refreshStatus()
        setSubmitting(null)
        setAccepted(null)
      }
    },
    [projectId, readOnly, submitting, pictureSec, savePrompt, setFigures, refreshStatus]
  )

  useEffect(() => {
    startGenerateRef.current = startGenerate
  }, [startGenerate])

  // Replacing existing music is confirmed first; the first piece starts at once (the button
  // already states its exact price).
  const requestGenerate = useCallback(() => {
    if (current) {
      setConfirm({
        content: {
          title: 'Replace the music?',
          body: 'New music replaces the current piece on the lane. The current file is kept, so nothing paid for is lost.',
          quote: null,
          confirmLabel: 'Generate',
        },
        credits: price,
        run: () => void startGenerate(price),
      })
    } else {
      void startGenerate(price)
    }
  }, [current, price, startGenerate])

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file || readOnly) return
      setError(null)
      const mime = uploadMime(file)
      if (!mime) return setError({ kind: 'error', message: 'Upload an MP3, WAV or M4A file.' })
      if (file.size > MUSIC_UPLOAD_MAX_BYTES) return setError({ kind: 'error', message: 'That file is too large.' })
      setSubmitting('upload')
      try {
        const res = await fetch(`/api/projects/${projectId}/music/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mime, bytes: file.size }),
        })
        const body = await readJson(res)
        if (!res.ok || typeof body?.token !== 'string' || typeof body.path !== 'string') {
          setError({ kind: 'error', message: typeof body?.error === 'string' ? body.error : "The file couldn't be uploaded." })
          return
        }
        const { error: uploadError } = await createBrowserSupabase()
          .storage.from('artifacts')
          .uploadToSignedUrl(body.path, body.token, file, { contentType: mime })
        if (uploadError) {
          setError({ kind: 'error', message: "The file couldn't be uploaded. Try again." })
          return
        }
        // The server reads the duration from the stored file and links it.
        const linkRes = await fetch(`/api/projects/${projectId}/music/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attemptId: body.attemptId, ext: body.ext }),
        })
        const linkBody = await readJson(linkRes)
        if (!linkRes.ok) {
          const tooLong = linkBody?.code === 'too_long'
          setError({
            kind: 'error',
            message: tooLong
              ? `Music can be at most ${formatTimecode(MUSIC_UPLOAD_MAX_SEC)} long.`
              : typeof linkBody?.error === 'string'
                ? linkBody.error
                : "The file couldn't be used. Try again.",
          })
          return
        }
        setChoosing(false)
      } catch {
        setError({ kind: 'error', message: "The file couldn't be uploaded. Try again." })
      } finally {
        await refreshStatus()
        setSubmitting(null)
      }
    },
    [projectId, readOnly, refreshStatus]
  )

  const openFilePicker = () => fileRef.current?.click()

  const remove = useCallback(async () => {
    setError(null)
    audioRef.current?.pause()
    setPlaying(false)
    const result = await removeMusic(projectId).catch(() => ({ success: false }) as const)
    if (!result.success) setError({ kind: 'error', message: "The music couldn't be removed. Try again." })
    await refreshStatus()
  }, [projectId, refreshStatus])

  const toggleMute = useCallback(async () => {
    const next = !isMuted
    setMutedOverride({ key: muteKey, value: next })
    const result = await setMusicMuted(projectId, next).catch(() => ({ success: false }) as const)
    if (!result.success) {
      setMutedOverride(null)
      setError({ kind: 'error', message: "That change couldn't be saved. Try again." })
      return
    }
    await refreshStatus()
  }, [isMuted, muteKey, projectId, refreshStatus])

  const setLoop = useCallback(
    async (next: boolean) => {
      setLoopOverride({ key: loopKey, value: next })
      const result = await setMusicLoop(projectId, next).catch(() => ({ success: false }) as const)
      if (!result.success) {
        setLoopOverride(null)
        setError({ kind: 'error', message: "That change couldn't be saved. Try again." })
        return
      }
      await refreshStatus()
    },
    [loopKey, projectId, refreshStatus]
  )

  // Generating: how long it should take (a display estimate).
  const now = useNow(view === 'generating')
  const genSec = accepted?.seconds ?? music.attemptSec ?? requestedMusicSec(pictureSec)
  const genCredits = creditsFor({ step: 'storyboard', operation: 'background_music', quantity: genSec })
  const etaMs = MUSIC_ETA_BASE_MS + genSec * MUSIC_ETA_MS_PER_SEC
  const elapsed = music.startedAt && now ? Math.max(0, now - new Date(music.startedAt).getTime()) : 0
  const pct = Math.min(95, (elapsed / etaMs) * 100)
  const leftSec = Math.max(0, Math.round((etaMs - elapsed) / 1000))
  const eta = leftSec > 0 ? `~${leftSec}s left` : 'Almost done'
  const writingSec = Math.round(genSec)

  const who = current
    ? current.source === 'uploaded'
      ? `Uploaded · ${formatTimecode(current.durationSec)}`
      : `Generated from your style prompt · ${formatClockTime(current.generatedAt)}`
    : ''
  const note = current && isLooped && current.durationSec < pictureSec ? `${who} · Looped to fit` : who
  const bars = useMemo(() => (current ? musicBars(current.path, 60) : []), [current])

  const pending = submitting !== null
  const pendingMark = <Spinner className="h-[11px] w-[11px]" thickness={1.3} />
  const duration = formatTimecode(current?.durationSec ?? 0)

  const loopButton = (
    <button
      type="button"
      data-testid="music-loop"
      disabled={readOnly}
      onClick={(e) => {
        e.stopPropagation()
        void setLoop(true)
      }}
      className={LOOP_BUTTON}
    >
      Loop to fit <span className="font-mono text-mono">free</span>
    </button>
  )

  const muteButton = (
    <button
      type="button"
      data-testid="music-mute"
      disabled={readOnly}
      onClick={(e) => {
        e.stopPropagation()
        void toggleMute()
      }}
      className={SMALL_BUTTON}
    >
      {isMuted ? 'Unmute' : 'Mute'}
    </button>
  )

  const collapsedNote: Record<CardView, ReactNode> = {
    empty: <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-tertiary">Optional · Not generated</span>,
    generating: (
      <>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-secondary">
          Writing {writingSec} seconds
        </span>
        <span className="flex-none font-mono text-mono text-text-secondary">{eta}</span>
        <span className="absolute inset-x-0 bottom-0 block h-[2px] bg-sb-active-line">
          <span className="block h-[2px] bg-sb-active-fg" style={{ width: `${pct}%` }} />
        </span>
      </>
    ),
    failed: (
      <>
        <span className="flex-none rounded-badge border border-status-failed-line bg-status-failed-bg px-[7px] py-[2px] text-chip font-medium uppercase tracking-label text-status-failed-fg">
          Failed
        </span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-tertiary">
          The music service didn’t respond · You were not charged
        </span>
      </>
    ),
    present: (
      <>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-tertiary">{note}</span>
        <PlayButton playing={playing} onClick={togglePlay} />
        <span className="flex-none font-mono text-mono text-text-tertiary">{duration}</span>
        {muteButton}
      </>
    ),
    short: (
      <>
        <span
          data-testid="music-short-chip"
          className="flex-none whitespace-nowrap rounded-badge border border-sb-warn-line bg-sb-warn-bg px-[7px] py-[2px] text-chip font-medium text-sb-warn-fg"
        >
          {duration} · Shorter than picture
        </span>
        {loopButton}
        <span className="flex-1" />
        <PlayButton playing={playing} onClick={togglePlay} />
        <span className="flex-none font-mono text-mono text-text-tertiary">{duration}</span>
        {muteButton}
      </>
    ),
  }

  const border =
    view === 'failed' ? 'border-status-failed-line' : view === 'generating' ? 'border-border-strong' : 'border-border-subtle'

  const header = (text: ReactNode, tone: 'tertiary' | 'secondary' = 'tertiary', trailing?: ReactNode) => (
    <div className="flex items-center gap-[10px]">
      <button type="button" aria-expanded onClick={() => setOpen(false)} className="flex cursor-pointer items-center gap-[10px]">
        <Chevron open />
        <Ident />
      </button>
      <span className={`flex-1 text-meta ${tone === 'secondary' ? 'text-text-secondary' : 'text-text-tertiary'}`}>{text}</span>
      {trailing}
    </div>
  )

  let expanded: ReactNode
  if (view === 'empty') {
    expanded = (
      <>
        {header('Optional · A style prompt derived from your script, yours to edit')}
        <div className="flex items-center gap-[10px]">
          <input
            type="text"
            data-testid="music-style-prompt"
            aria-label="Music style prompt"
            value={prompt}
            maxLength={MUSIC_STYLE_PROMPT_EDIT_MAX_CHARS}
            disabled={readOnly}
            placeholder={deriving ? 'Writing a style prompt from your script…' : PLACEHOLDER}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => void savePrompt()}
            className="h-[32px] min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-control border border-border-strong bg-bg-surface px-[11px] text-small text-text-secondary placeholder:text-text-quiet hover:border-border-strong-hover focus:outline-none disabled:cursor-not-allowed"
          />
          {choosing && (
            <button type="button" onClick={() => setChoosing(false)} className={SMALL_BUTTON}>
              Cancel
            </button>
          )}
          <button
            type="button"
            data-testid="upload-music"
            disabled={readOnly || pending}
            aria-busy={submitting === 'upload'}
            onClick={openFilePicker}
            className="flex h-[30px] flex-none cursor-pointer items-center gap-[6px] rounded-control border border-border-subtle px-[11px] text-small text-text-secondary hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting === 'upload' && pendingMark}
            Upload
          </button>
          <button
            type="button"
            data-testid="generate-music"
            disabled={readOnly || pending || prompt.trim() === '' || pictureSec <= 0}
            aria-busy={submitting === 'generate'}
            onClick={requestGenerate}
            className="flex h-[30px] flex-none cursor-pointer items-center gap-[8px] whitespace-nowrap rounded-control border border-border-strong bg-bg-inset px-[13px] text-small leading-none font-medium text-text-primary hover:border-border-strong-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting === 'generate' && pendingMark}
            Generate music
            <Price credits={price} />
          </button>
        </div>
      </>
    )
  } else if (view === 'generating') {
    expanded = (
      <>
        {header(`Writing ${writingSec} seconds from your style prompt`, 'secondary', <span className="font-mono text-mono text-text-secondary">{eta}</span>)}
        <div className="h-[3px] overflow-hidden rounded-[2px] bg-sb-active-line">
          <span className="block h-[3px] rounded-[2px] bg-sb-active-fg" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-meta text-text-tertiary">
          {formatCredits(genCredits)} {genCredits === 1 ? 'credit' : 'credits'} committed. Editing the style prompt now will not
          affect this run.
        </span>
      </>
    )
  } else if (view === 'failed') {
    expanded = (
      <div className="flex items-center gap-[12px]">
        <button type="button" aria-expanded onClick={() => setOpen(false)} className="flex cursor-pointer items-center gap-[10px]">
          <Chevron open />
          <Ident />
        </button>
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="text-small font-medium text-banner-failed-title">The music service didn’t respond</span>
          <span className="text-meta text-banner-failed-body">
            You were not charged. Your style prompt is kept.{' '}
            {music.failedAt && <span className="font-mono text-label">{formatClockTime(music.failedAt)}</span>}
          </span>
        </span>
        <button type="button" onClick={() => setChoosing(true)} disabled={readOnly} className={SMALL_BUTTON}>
          Edit prompt
        </button>
        <button
          type="button"
          data-testid="music-try-again"
          disabled={readOnly || pending || prompt.trim() === ''}
          aria-busy={pending}
          onClick={() => void startGenerate(price)}
          className="flex h-[30px] flex-none cursor-pointer items-center gap-[7px] rounded-control border border-status-failed-line px-[12px] text-small leading-none font-medium text-status-failed-fg hover:bg-status-failed-bg disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending && pendingMark}
          Try again <span className="font-mono text-mono font-normal">{formatCredits(price)} cr</span>
        </button>
      </div>
    )
  } else {
    expanded = (
      <>
        {header(note)}
        <div className="flex flex-col gap-[9px]">
          <div className="flex items-center gap-[12px]">
            <PlayButton playing={playing} onClick={togglePlay} />
            <span className={`flex h-[26px] min-w-0 flex-1 items-center gap-[2px] ${isMuted ? 'opacity-60' : ''}`} aria-hidden="true">
              {bars.map((h, i) => (
                <span key={i} className="flex-1 rounded-[1px] bg-text-quiet opacity-50" style={{ height: h }} />
              ))}
            </span>
            <span className="flex-none font-mono text-mono text-text-tertiary">{duration}</span>
            <span className="flex flex-none items-center gap-[6px]">
              <button type="button" data-testid="music-regenerate" disabled={readOnly || pending} onClick={() => setChoosing(true)} className={SMALL_BUTTON}>
                Regenerate <Price credits={price} />
              </button>
              <button
                type="button"
                disabled={readOnly || pending}
                aria-busy={submitting === 'upload'}
                onClick={openFilePicker}
                className={SMALL_BUTTON}
              >
                {submitting === 'upload' && pendingMark}
                Upload
              </button>
              {muteButton}
              <button type="button" data-testid="music-remove" disabled={readOnly} onClick={() => void remove()} className={SMALL_BUTTON}>
                Remove
              </button>
            </span>
          </div>
          {view === 'short' && current && (
            <div className="relative flex items-center gap-rc-sm overflow-hidden rounded-control bg-sb-warn-bg p-[9px_12px]">
              <span className="absolute inset-y-0 left-0 w-[2px] bg-sb-warn-fg" />
              <span data-testid="music-short-message" className="flex-1 pl-rc-2xs text-small text-sb-warn-body">
                {shorterMessage(current.durationSec, pictureSec)}
              </span>
              {loopButton}
            </div>
          )}
          {isLooped && current && current.durationSec < pictureSec && (
            <div className="flex items-center gap-[10px]">
              <span className="flex-1 text-meta text-text-tertiary">
                The music repeats with a short crossfade until the picture ends.
              </span>
              <button type="button" data-testid="music-unloop" disabled={readOnly} onClick={() => void setLoop(false)} className={SMALL_BUTTON}>
                Stop looping
              </button>
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-[8px]">
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        hidden
        data-testid="music-file"
        onChange={(e) => {
          void onFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {open ? (
        <div
          data-testid="music-section"
          data-state={view}
          className={`flex flex-col gap-[10px] rounded-frame border bg-bg-canvas p-[11px_14px] ${border}`}
        >
          {expanded}
        </div>
      ) : (
        <div
          data-testid="music-section"
          data-state={view}
          role="button"
          tabIndex={0}
          aria-expanded={false}
          title="Show music"
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              setOpen(true)
            }
          }}
          className={`relative flex h-[49.25px] flex-none cursor-pointer items-center gap-[12px] overflow-hidden rounded-frame border bg-bg-canvas px-[15px] hover:border-border-strong-hover ${border}`}
        >
          <Chevron open={false} />
          <Ident />
          {collapsedNote[view]}
        </div>
      )}

      {error?.kind === 'credits' && (
        <InsufficientCreditsBanner
          title="Not enough credits for this music"
          subject="This"
          requiredCredits={error.requiredCredits}
          balanceCredits={error.balanceCredits}
        />
      )}
      {error?.kind === 'error' && (
        <span role="alert" data-testid="music-error" className="text-small text-status-failed-fg">
          {error.message}
        </span>
      )}

      <PromptConfirmModal
        content={confirm?.content ?? null}
        credits={confirm?.credits ?? 0}
        onConfirm={() => {
          const run = confirm?.run
          setConfirm(null)
          run?.()
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}
