'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { InsufficientCreditsBanner } from '@/components/insufficient-credits-banner'
import { PromptConfirmModal, type PromptConfirmContent } from '@/components/prompt-confirm-modal'
import { parseRailFigures, useRailFigures } from '@/components/rail-figures-context'
import { createClient as createBrowserSupabase } from '@/lib/supabase/client'
import { creditsFor } from '@/lib/config/credits'
import { voicesForLanguage, type VoiceoverVoice } from '@/lib/config/models'
import {
  VOICEOVER_ALIGN_ETA_MS,
  VOICEOVER_ETA_CHARS_PER_SEC,
  VOICEOVER_SPOKEN_CHARS_PER_SEC,
  VOICEOVER_UPLOAD_FORMATS,
  VOICEOVER_UPLOAD_MAX_BYTES,
  VOICEOVER_UPLOAD_MAX_SEC,
} from '@/lib/config/storyboard'
import { formatClockTime } from '@/lib/format-clock-time'
import { formatCredits } from '@/lib/format-credits'
import { languageLabel } from '@/lib/language-labels'
import { formatTimecode } from '@/lib/storyboard/timeline'
import { buildScript, speechBars, type VoiceoverStaleness } from '@/lib/storyboard/voiceover'
import { removeVoiceover, setVoiceoverMuted } from '../actions'
import { useStoryboard } from './storyboard-context'
import { useNow } from './use-now'
import type { StoryboardShot } from './types'

// The Voiceover card under the timeline (canvas 15f): five states - empty, generating,
// failed, present, stale - each with a collapsed line of fixed height and an expanded
// card. Generating and aligning are paid and run in the background; the lane learns the
// outcome from the page's one status poll. Everything else here is free.

export function voiceoverPrice(chars: number): number {
  return chars > 0 ? creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: chars }) : 0
}

export function alignPrice(seconds: number): number {
  return creditsFor({ step: 'storyboard', operation: 'align_voiceover', quantity: seconds })
}

const EXT_MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }
const ACCEPT = Object.keys(VOICEOVER_UPLOAD_FORMATS).join(',')

// A picked file's type, falling back to its extension when the browser reports none.
function uploadMime(file: File): string | null {
  if (VOICEOVER_UPLOAD_FORMATS[file.type]) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? null
}

function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    const done = (value: number | null) => {
      URL.revokeObjectURL(url)
      resolve(value)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null)
    audio.onerror = () => done(null)
    audio.src = url
  })
}

function shotList(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b)
  if (sorted.length === 1) return `Shot ${sorted[0]}`
  return `Shots ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`
}

// Which shot made the read stale, and how. One sentence; the bin comes first because it is
// the edit most likely to have been deliberate.
export function staleMessage(staleness: VoiceoverStaleness, shots: StoryboardShot[]): string {
  const number = (id: string) => (shots.find((s) => s.id === id)?.order_index ?? -1) + 1
  const numbers = (ids: string[]) => ids.map(number).filter((n) => n > 0)
  if (staleness.binned.length > 0) {
    const n = numbers(staleness.binned)
    const one = n.length === 1
    return `${n.length > 0 ? shotList(n) : 'A shot'} ${one ? 'was' : 'were'} removed, but ${one ? 'its' : 'their'} narration is still in this read — the voice describes ${one ? 'a shot that is' : 'shots that are'} no longer in the film. Nothing regenerates on its own.`
  }
  if (staleness.edited.length > 0) {
    const n = numbers(staleness.edited)
    return `${shotList(n)}’s narration changed after this read, so the voice no longer says what the script does. Nothing regenerates on its own.`
  }
  const n = numbers(staleness.missing)
  const one = n.length === 1
  return `${shotList(n)} ${one ? 'isn’t' : 'aren’t'} in this read — ${one ? 'it was' : 'they were'} added to the film after the voiceover was made. Nothing regenerates on its own.`
}

type CardView = 'empty' | 'generating' | 'failed' | 'present' | 'stale'

type Submitting = { mode: 'generate'; voiceId: string; chars: number } | { mode: 'upload'; durationSec: number }

type CardError =
  | { kind: 'credits'; requiredCredits: number; balanceCredits: number | null }
  | { kind: 'error'; message: string }

type Confirm = { content: PromptConfirmContent; credits: number; run: () => void }

// Storage has no same-tab change event worth subscribing to; local state carries changes.
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
      <span className="h-[13px] w-[2px] rounded-[1px] bg-ident-voiceover-fg" />
      <span className="text-label uppercase tracking-label text-ident-voiceover-fg">Voiceover</span>
    </span>
  )
}

function StateChip({ kind }: { kind: 'failed' | 'stale' }) {
  return (
    <span
      className={`flex-none rounded-badge border px-[7px] py-[2px] text-chip font-medium uppercase tracking-label ${
        kind === 'failed'
          ? 'border-status-failed-line bg-status-failed-bg text-status-failed-fg'
          : 'border-status-stale-line bg-status-stale-bg text-status-stale-fg'
      }`}
    >
      {kind === 'failed' ? 'Failed' : 'Stale'}
    </span>
  )
}

function Price({ credits }: { credits: number }) {
  return <span className="font-mono text-mono font-normal text-text-tertiary">{formatCredits(credits)} cr</span>
}

const SMALL_BUTTON =
  'flex h-[26px] flex-none cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-control border border-border-subtle px-[9px] text-small leading-none text-text-secondary hover:border-border-strong hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60'

function PlayButton({ playing, onClick, label }: { playing: boolean; onClick: () => void; label: string }) {
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

function Waveform({ bars, dim }: { bars: { mini: number }[]; dim?: boolean }) {
  return (
    <span className={`flex h-[26px] min-w-0 flex-1 items-center gap-[2px] ${dim ? 'opacity-70' : ''}`} aria-hidden="true">
      {bars.map((b, i) => (
        <span key={i} className="flex-1 rounded-[1px] bg-ident-voiceover-fg opacity-50" style={{ height: b.mini }} />
      ))}
    </span>
  )
}

function VoiceCards({
  voices,
  pickedId,
  playingKey,
  onPick,
  onAudition,
}: {
  voices: VoiceoverVoice[]
  pickedId: string | null
  playingKey: string | null
  onPick: (id: string) => void
  onAudition: (voice: VoiceoverVoice) => void
}) {
  return (
    <div className="flex gap-[8px]" role="radiogroup" aria-label="Voice">
      {voices.map((voice) => {
        const picked = voice.id === pickedId
        return (
          <div
            key={voice.id}
            role="radio"
            aria-checked={picked}
            tabIndex={0}
            data-testid="voice-card"
            onClick={() => onPick(voice.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPick(voice.id)
              }
            }}
            className={`flex h-[40px] min-w-0 flex-1 cursor-pointer items-center gap-[9px] rounded-control border px-[10px] hover:border-border-strong-hover ${
              picked ? 'border-border-strong-hover bg-bg-inset' : 'border-border-subtle bg-bg-surface'
            }`}
          >
            <button
              type="button"
              aria-label={`Play a sample of ${voice.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onAudition(voice)
              }}
              className="flex h-[24px] w-[24px] flex-none cursor-pointer items-center justify-center rounded-full border border-border-strong text-text-secondary hover:border-accent hover:text-accent"
            >
              <PlayGlyph playing={playingKey === `sample:${voice.id}`} />
            </button>
            <span className="flex min-w-0 flex-col gap-px">
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-small leading-[1.2] font-medium">{voice.name}</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-meta leading-[1.2] text-text-tertiary">
                {voice.descriptor}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// The narration language. v1 offers only the project's own language.
function LanguagePicker({ language }: { language: string | null }) {
  return (
    <span
      data-testid="voiceover-language"
      className="flex h-[26px] flex-none items-center gap-[6px] rounded-control border border-border-subtle px-[9px] text-small text-text-secondary"
    >
      {languageLabel(language) ?? 'English'}
      <svg width="8" height="5" viewBox="0 0 9 6" fill="none" aria-hidden="true">
        <path d="M1 1.25 4.5 4.75 8 1.25" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </span>
  )
}

export function VoiceoverCard({ language }: { language: string | null }) {
  const { projectId, readOnly, shots, voiceover, refreshStatus, voiceoverStaleness } = useStoryboard()
  const { setFigures } = useRailFigures()
  const voices = useMemo(() => voicesForLanguage(language), [language])
  const current = voiceover.current
  const script = useMemo(() => buildScript(shots), [shots])
  const chars = script.text.length
  const price = voiceoverPrice(chars)

  const [submitting, setSubmitting] = useState<Submitting | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [error, setError] = useState<CardError | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  // An optimistic Mute, keyed to the read it was set on - a new read (or the server
  // confirming) retires it without an effect.
  const [mutedOverride, setMutedOverride] = useState<{ key: string; value: boolean } | null>(null)
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const voiceName = (id: string | null) => voices.find((v) => v.id === id)?.name ?? null
  const picked = pickedId ?? current?.voiceId ?? voiceover.attemptVoiceId ?? voices[0]?.id ?? null
  const muteKey = `${current?.generatedAt ?? ''}:${current?.muted ?? false}`
  const isMuted = mutedOverride?.key === muteKey ? mutedOverride.value : (current?.muted ?? false)

  const inFlight = submitting !== null || voiceover.state === 'generating'
  const stale = !!current && !!voiceoverStaleness?.stale
  const view: CardView = inFlight
    ? 'generating'
    : choosing
      ? 'empty'
      : voiceover.state === 'failed'
        ? 'failed'
        : !current
          ? 'empty'
          : stale
            ? 'stale'
            : 'present'

  // Open or closed is remembered per project; a card opens once when its lane moves into
  // Failed or Stale, so the message is seen - after that the person's collapse is respected.
  const openKey = `reelcraft.storyboard.voiceoverOpen.${projectId}`
  const seenKey = `reelcraft.storyboard.voiceoverSeen.${projectId}`
  const storedOpen = useSyncExternalStore(noSubscribe, () => readStored(openKey), () => null)
  const storedSeen = useSyncExternalStore(noSubscribe, () => readStored(seenKey), () => null)
  const [openChoice, setOpenChoice] = useState<boolean | null>(null)
  const attention =
    view === 'failed' ? `failed:${voiceover.failedAt}` : view === 'stale' ? `stale:${current?.generatedAt}` : null
  const [seenChoice, setSeenChoice] = useState<string | null>(null)
  const unseen = attention !== null && attention !== (seenChoice ?? storedSeen)
  const open = unseen || (openChoice ?? storedOpen === '1')
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenChoice(next)
      writeStored(openKey, next ? '1' : '0')
      // Collapsing (or opening) a card that asked for attention counts as having seen it.
      if (attention) {
        setSeenChoice(attention)
        writeStored(seenKey, attention)
      }
    },
    [openKey, seenKey, attention]
  )

  // One shared player for the samples and the read, so two never play at once.
  const play = useCallback((key: string, src: string | null) => {
    if (!src) return
    let audio = audioRef.current
    if (!audio) {
      audio = new Audio()
      audio.onended = () => setPlayingKey(null)
      audioRef.current = audio
    }
    if (playingKey === key) {
      audio.pause()
      setPlayingKey(null)
      return
    }
    audio.pause()
    audio.src = src
    void audio.play().then(
      () => setPlayingKey(key),
      () => setPlayingKey(null)
    )
  }, [playingKey])
  useEffect(() => () => audioRef.current?.pause(), [])

  const handleResponse = useCallback(
    async (res: Response, body: Record<string, unknown> | null, retry: (credits: number) => void) => {
      const rail = parseRailFigures(body?.rail)
      if (rail) setFigures(rail)
      if (res.ok) {
        setChoosing(false)
        return
      }
      if (res.status === 402) {
        setError({
          kind: 'credits',
          requiredCredits: Number(body?.requiredCredits ?? 0),
          balanceCredits: typeof body?.balanceCredits === 'number' ? body.balanceCredits : null,
        })
      } else if (res.status === 409 && body?.code === 'price_changed' && typeof body.credits === 'number') {
        const credits = body.credits
        setConfirm({
          content: {
            title: 'The price changed',
            body: 'The narration changed since this page loaded, so this costs a different amount now.',
            quote: null,
            confirmLabel: 'Continue',
          },
          credits,
          run: () => retry(credits),
        })
      } else if (res.status === 409 && body?.code === 'in_flight') {
        setError({ kind: 'error', message: 'A voiceover is already being made. It will appear here when it lands.' })
      } else if (typeof body?.error === 'string' && res.status === 422) {
        setError({ kind: 'error', message: body.error })
      } else {
        setError({ kind: 'error', message: "The voiceover couldn't be started. Try again." })
      }
    },
    [setFigures]
  )

  // A price-changed retry re-enters the same action; refs let it without a declaration cycle.
  const startGenerateRef = useRef<((voiceId: string, credits: number) => Promise<void>) | null>(null)
  const alignRef = useRef<((attemptId: string, ext: string, durationSec: number, credits: number) => Promise<void>) | null>(
    null
  )

  const startGenerate = useCallback(
    async (voiceId: string, credits: number) => {
      if (readOnly) return
      setError(null)
      setSubmitting({ mode: 'generate', voiceId, chars })
      try {
        const res = await fetch(`/api/projects/${projectId}/voiceover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voiceId, expectedCredits: credits }),
        })
        await handleResponse(res, await readJson(res), (next) => void startGenerateRef.current?.(voiceId, next))
      } catch {
        setError({ kind: 'error', message: "The voiceover couldn't be started. Try again." })
      } finally {
        await refreshStatus()
        setSubmitting(null)
      }
    },
    [projectId, readOnly, chars, handleResponse, refreshStatus]
  )

  useEffect(() => {
    startGenerateRef.current = startGenerate
  }, [startGenerate])

  // Regenerating over an existing read is confirmed first; the first read starts at once
  // (the button already states its exact price).
  const requestGenerate = useCallback(
    (voiceId: string) => {
      if (current) {
        setConfirm({
          content: {
            title: 'Replace the voiceover?',
            body: 'A new read replaces the current one on the lane. The current recording is kept, so nothing paid for is lost.',
            quote: null,
            confirmLabel: 'Regenerate',
          },
          credits: price,
          run: () => void startGenerate(voiceId, price),
        })
      } else {
        void startGenerate(voiceId, price)
      }
    },
    [current, price, startGenerate]
  )

  const align = useCallback(
    async (attemptId: string, ext: string, durationSec: number, credits: number) => {
      setSubmitting({ mode: 'upload', durationSec })
      try {
        const res = await fetch(`/api/projects/${projectId}/voiceover/align`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attemptId, ext, expectedCredits: credits }),
        })
        await handleResponse(res, await readJson(res), (next) => void alignRef.current?.(attemptId, ext, durationSec, next))
      } catch {
        setError({ kind: 'error', message: "The upload couldn't be aligned. Try again." })
      } finally {
        await refreshStatus()
        setSubmitting(null)
      }
    },
    [projectId, handleResponse, refreshStatus]
  )

  useEffect(() => {
    alignRef.current = align
  }, [align])

  const startUpload = useCallback(
    async (file: File, mime: string, durationSec: number, credits: number) => {
      setError(null)
      setSubmitting({ mode: 'upload', durationSec })
      try {
        const res = await fetch(`/api/projects/${projectId}/voiceover/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mime, bytes: file.size }),
        })
        const body = await readJson(res)
        if (!res.ok || typeof body?.token !== 'string' || typeof body.path !== 'string') {
          setError({ kind: 'error', message: typeof body?.error === 'string' ? body.error : "The file couldn't be uploaded." })
          setSubmitting(null)
          return
        }
        const { error: uploadError } = await createBrowserSupabase()
          .storage.from('artifacts')
          .uploadToSignedUrl(body.path, body.token, file, { contentType: mime })
        if (uploadError) {
          setError({ kind: 'error', message: "The file couldn't be uploaded. Try again." })
          setSubmitting(null)
          return
        }
        await align(String(body.attemptId), String(body.ext), durationSec, credits)
      } catch {
        setError({ kind: 'error', message: "The file couldn't be uploaded. Try again." })
        setSubmitting(null)
      }
    },
    [projectId, align]
  )

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file || readOnly) return
      setError(null)
      const mime = uploadMime(file)
      if (!mime) return setError({ kind: 'error', message: 'Upload an MP3, WAV or M4A recording.' })
      if (file.size > VOICEOVER_UPLOAD_MAX_BYTES) return setError({ kind: 'error', message: 'That file is too large.' })
      const durationSec = await readDuration(file)
      if (durationSec === null) return setError({ kind: 'error', message: 'That file couldn’t be read as audio.' })
      if (durationSec > VOICEOVER_UPLOAD_MAX_SEC) {
        return setError({ kind: 'error', message: `Recordings can be at most ${formatTimecode(VOICEOVER_UPLOAD_MAX_SEC)} long.` })
      }
      const credits = alignPrice(durationSec)
      setConfirm({
        content: {
          title: current ? 'Replace the voiceover with this recording?' : 'Use this recording?',
          body: `${file.name} · ${formatTimecode(durationSec)}. It is aligned to the script so Fit to voiceover works the same as for a generated read. You are charged only if the alignment succeeds.`,
          quote: null,
          confirmLabel: 'Upload and align',
        },
        credits,
        run: () => void startUpload(file, mime, durationSec, credits),
      })
    },
    [readOnly, current, startUpload]
  )

  const openFilePicker = () => fileRef.current?.click()

  const remove = useCallback(async () => {
    setError(null)
    const result = await removeVoiceover(projectId).catch(() => ({ success: false }) as const)
    if (!result.success) setError({ kind: 'error', message: "The voiceover couldn't be removed. Try again." })
    await refreshStatus()
  }, [projectId, refreshStatus])

  const toggleMute = useCallback(async () => {
    const next = !isMuted
    setMutedOverride({ key: muteKey, value: next })
    const result = await setVoiceoverMuted(projectId, next).catch(() => ({ success: false }) as const)
    if (!result.success) {
      setMutedOverride(null)
      setError({ kind: 'error', message: "That change couldn't be saved. Try again." })
      return
    }
    await refreshStatus()
  }, [isMuted, muteKey, projectId, refreshStatus])

  // Generating: what's being made, and how long it should take (a display estimate).
  const now = useNow(view === 'generating')
  const genMode = submitting?.mode ?? voiceover.mode ?? 'generate'
  const genVoice = voiceName(submitting?.mode === 'generate' ? submitting.voiceId : voiceover.attemptVoiceId)
  const genChars = submitting?.mode === 'generate' ? submitting.chars : (voiceover.attemptChars ?? chars)
  const genDuration = submitting?.mode === 'upload' ? submitting.durationSec : (voiceover.attemptDurationSec ?? 0)
  const genCredits = genMode === 'upload' ? alignPrice(genDuration) : voiceoverPrice(genChars)
  const etaMs = genMode === 'upload' ? VOICEOVER_ALIGN_ETA_MS : (genChars / VOICEOVER_ETA_CHARS_PER_SEC) * 1000
  const elapsed = voiceover.startedAt && now ? Math.max(0, now - new Date(voiceover.startedAt).getTime()) : 0
  const pct = Math.min(95, etaMs > 0 ? (elapsed / etaMs) * 100 : 0)
  const leftSec = Math.max(0, Math.round((etaMs - elapsed) / 1000))
  const eta = leftSec > 0 ? `~${leftSec}s left` : 'Almost done'
  const readingSec = Math.max(1, Math.round(genChars / VOICEOVER_SPOKEN_CHARS_PER_SEC))
  const langName = languageLabel(language) ?? 'English'
  const genLine =
    genMode === 'upload'
      ? `Aligning ${formatTimecode(genDuration)} of your recording`
      : `${genVoice ? `${genVoice} · ` : ''}Reading ${readingSec} seconds`

  // Present: who read it, when.
  const who = current
    ? current.source === 'uploaded'
      ? `Uploaded · ${langName} · Aligned ${formatClockTime(current.generatedAt)}`
      : `${voiceName(current.voiceId) ?? 'Voiceover'} · ${langName} · Generated ${formatClockTime(current.generatedAt)}`
    : ''
  const bars = useMemo(() => (current ? speechBars(current.spans, current.durationSec, 60) : []), [current])
  const readKey = 'read'
  const playRead = () => play(readKey, current?.audioUrl ?? null)

  // Failed: what was tried, and the price of trying again.
  const failedUpload = voiceover.mode === 'upload'
  const retryVoice = voiceover.attemptVoiceId ?? picked
  const retryCredits = failedUpload
    ? voiceover.retryUpload
      ? alignPrice(voiceover.retryUpload.durationSec)
      : null
    : price
  const tryAgain = () => {
    if (failedUpload) {
      const r = voiceover.retryUpload
      if (r) void align(r.attemptId, r.ext, r.durationSec, alignPrice(r.durationSec))
      else openFilePicker()
    } else if (retryVoice) {
      void startGenerate(retryVoice, price)
    }
  }

  const collapsedNote: Record<CardView, ReactNode> = {
    empty: <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-tertiary">Optional · Not generated</span>,
    generating: (
      <>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-secondary">{genLine}</span>
        <span className="flex-none font-mono text-mono text-text-secondary">{eta}</span>
        <span className="absolute inset-x-0 bottom-0 block h-[2px] bg-sb-active-line">
          <span className="block h-[2px] bg-sb-active-fg" style={{ width: `${pct}%` }} />
        </span>
      </>
    ),
    failed: (
      <>
        <StateChip kind="failed" />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-tertiary">
          {failedUpload ? 'The upload couldn’t be aligned' : 'The read didn’t come back'} · You were not charged
        </span>
      </>
    ),
    present: (
      <>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-tertiary">{who}</span>
        <PlayButton playing={playingKey === readKey} onClick={playRead} label={playingKey === readKey ? 'Pause voiceover' : 'Play voiceover alone'} />
        <span className="flex-none font-mono text-mono text-text-tertiary">{formatTimecode(current?.durationSec ?? 0)}</span>
        <button type="button" disabled={readOnly} onClick={(e) => (e.stopPropagation(), void toggleMute())} className={SMALL_BUTTON}>
          {isMuted ? 'Unmute' : 'Mute'}
        </button>
      </>
    ),
    stale: (
      <>
        <StateChip kind="stale" />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-tertiary">
          {current?.source === 'uploaded' ? `Uploaded · ${langName}` : `${voiceName(current?.voiceId ?? null) ?? 'Voiceover'} · ${langName}`}
        </span>
        <PlayButton playing={playingKey === readKey} onClick={playRead} label={playingKey === readKey ? 'Pause voiceover' : 'Play voiceover alone'} />
        <span className="flex-none font-mono text-mono text-text-tertiary">{formatTimecode(current?.durationSec ?? 0)}</span>
        <button type="button" disabled={readOnly} onClick={(e) => (e.stopPropagation(), void toggleMute())} className={SMALL_BUTTON}>
          {isMuted ? 'Unmute' : 'Mute'}
        </button>
      </>
    ),
  }

  const border =
    view === 'failed'
      ? 'border-status-failed-line'
      : view === 'stale'
        ? 'border-status-stale-line'
        : view === 'generating'
          ? 'border-border-strong'
          : 'border-border-subtle'

  const generateButton = (voiceId: string | null) => (
    <button
      type="button"
      data-testid="generate-voiceover"
      disabled={readOnly || !voiceId || chars === 0}
      onClick={() => voiceId && requestGenerate(voiceId)}
      className="flex h-[30px] flex-none cursor-pointer items-center gap-[8px] whitespace-nowrap rounded-control border border-border-strong bg-bg-inset px-[13px] text-small leading-none font-medium text-text-primary hover:border-border-strong-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      {current ? 'Regenerate voiceover' : 'Generate voiceover'}
      <Price credits={price} />
    </button>
  )

  const uploadButton = (size: 'lg' | 'sm') => (
    <button
      type="button"
      data-testid="upload-voiceover"
      disabled={readOnly}
      onClick={openFilePicker}
      className={
        size === 'lg'
          ? 'flex h-[30px] flex-none cursor-pointer items-center rounded-control border border-border-subtle px-[11px] text-small text-text-secondary hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60'
          : SMALL_BUTTON
      }
    >
      Upload
    </button>
  )

  let expanded: ReactNode
  if (view === 'empty') {
    expanded = (
      <>
        <div className="flex items-center gap-[10px]">
          <button type="button" aria-expanded onClick={() => setOpen(false)} className="flex cursor-pointer items-center gap-[10px]">
            <Chevron open />
            <Ident />
          </button>
          <span className="flex-1 text-meta text-text-tertiary">Optional · Pick a voice, or leave the film silent</span>
          <LanguagePicker language={language} />
        </div>
        <div className="flex flex-col gap-[9px]">
          {voices.length > 0 ? (
            <VoiceCards
              voices={voices}
              pickedId={picked}
              playingKey={playingKey}
              onPick={setPickedId}
              onAudition={(v) => play(`sample:${v.id}`, v.samplePath)}
            />
          ) : (
            <span className="text-meta text-text-tertiary">No voices are offered for this language yet — upload a recording instead.</span>
          )}
          <div className="flex items-center gap-[10px]">
            <span className="flex-1 text-meta text-text-tertiary">
              {chars === 0
                ? 'There is no narration to read yet. Add voiceover text to a shot on the workbench.'
                : 'Auditioning voices is free — the samples are pre-rendered. You are charged once, when you generate.'}
            </span>
            {choosing && (
              <button type="button" onClick={() => setChoosing(false)} className={SMALL_BUTTON}>
                Cancel
              </button>
            )}
            {uploadButton('lg')}
            {voices.length > 0 && generateButton(picked)}
          </div>
        </div>
      </>
    )
  } else if (view === 'generating') {
    expanded = (
      <>
        <div className="flex items-center gap-[10px]">
          <button type="button" aria-expanded onClick={() => setOpen(false)} className="flex cursor-pointer items-center gap-[10px]">
            <Chevron open />
            <Ident />
          </button>
          <span className="flex-1 text-meta text-text-secondary">
            {genMode === 'upload' ? genLine : `${genVoice ? `${genVoice} · ` : ''}${langName} · Reading ${readingSec} seconds of narration`}
          </span>
          <span className="font-mono text-mono text-text-secondary">{eta}</span>
        </div>
        <div className="h-[3px] overflow-hidden rounded-[2px] bg-sb-active-line">
          <span className="block h-[3px] rounded-[2px] bg-sb-active-fg" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-meta text-text-tertiary">
          {formatCredits(genCredits)} {genCredits === 1 ? 'credit' : 'credits'} committed. The lane stays empty until the read
          lands — nothing is part-written.
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
          <span className="text-small font-medium text-banner-failed-title">
            {failedUpload ? 'The upload couldn’t be aligned' : 'The read didn’t come back'}
          </span>
          <span className="text-meta text-banner-failed-body">
            You were not charged. {failedUpload ? 'Your recording and the script are kept.' : 'Your voice choice and the script are kept.'}{' '}
            {voiceover.failedAt && <span className="font-mono text-label">{formatClockTime(voiceover.failedAt)}</span>}
          </span>
        </span>
        {!failedUpload && (
          <button type="button" onClick={() => setChoosing(true)} disabled={readOnly} className={SMALL_BUTTON}>
            Change voice
          </button>
        )}
        <button
          type="button"
          data-testid="voiceover-try-again"
          disabled={readOnly || (!failedUpload && chars === 0)}
          onClick={tryAgain}
          className="flex h-[30px] flex-none cursor-pointer items-center gap-[7px] rounded-control border border-status-failed-line px-[12px] text-small leading-none font-medium text-status-failed-fg hover:bg-status-failed-bg disabled:cursor-not-allowed disabled:opacity-60"
        >
          Try again
          {retryCredits !== null && <span className="font-mono text-mono font-normal">{formatCredits(retryCredits)} cr</span>}
        </button>
      </div>
    )
  } else {
    expanded = (
      <>
        <div className="flex items-center gap-[10px]">
          <button type="button" aria-expanded onClick={() => setOpen(false)} className="flex cursor-pointer items-center gap-[10px]">
            <Chevron open />
            <Ident />
          </button>
          {view === 'stale' && <StateChip kind="stale" />}
          <span className="flex-1 text-meta text-text-tertiary">{who}</span>
        </div>
        <div className="flex items-center gap-[12px]">
          <PlayButton playing={playingKey === readKey} onClick={playRead} label={playingKey === readKey ? 'Pause voiceover' : 'Play voiceover alone'} />
          <Waveform bars={bars} dim={view === 'stale' || isMuted} />
          <span className="flex-none font-mono text-mono text-text-tertiary">{formatTimecode(current?.durationSec ?? 0)}</span>
          {view === 'present' && (
            <span className="flex flex-none items-center gap-[6px]">
              <button type="button" disabled={readOnly} onClick={() => setChoosing(true)} className={SMALL_BUTTON}>
                Regenerate <Price credits={price} />
              </button>
              {uploadButton('sm')}
              <button type="button" data-testid="voiceover-mute" disabled={readOnly} onClick={() => void toggleMute()} className={SMALL_BUTTON}>
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button type="button" data-testid="voiceover-remove" disabled={readOnly} onClick={() => void remove()} className={SMALL_BUTTON}>
                Remove
              </button>
            </span>
          )}
        </div>
        {view === 'stale' && voiceoverStaleness ? (
          <div className="relative flex items-center gap-rc-sm overflow-hidden rounded-control bg-status-stale-bg p-[10px_12px]">
            <span className="absolute inset-y-0 left-0 w-[2px] bg-status-stale-fg" />
            <span data-testid="voiceover-stale-message" className="flex-1 pl-rc-2xs text-small leading-[1.5] text-status-stale-fg">
              {staleMessage(voiceoverStaleness, shots)}
            </span>
            <button
              type="button"
              data-testid="voiceover-regenerate-stale"
              disabled={readOnly || chars === 0}
              onClick={() => (current?.voiceId ? requestGenerate(current.voiceId) : setChoosing(true))}
              className="flex h-[28px] flex-none cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-control border border-status-stale-line bg-bg-canvas px-[11px] text-small leading-none font-medium text-status-stale-fg hover:bg-status-stale-bg disabled:cursor-not-allowed disabled:opacity-60"
            >
              Regenerate voiceover <span className="font-mono text-mono font-normal">{formatCredits(price)} cr</span>
            </button>
          </div>
        ) : (
          <span className="text-meta text-text-tertiary">
            An uploaded read is aligned the same way a generated one is, so Fit to voiceover and captions work identically.
          </span>
        )}
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
        data-testid="voiceover-file"
        onChange={(e) => {
          void onFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {open ? (
        <div
          data-testid="voiceover-section"
          data-state={view}
          className={`flex flex-col gap-[10px] rounded-frame border bg-bg-canvas p-[11px_14px] ${border}`}
        >
          {expanded}
        </div>
      ) : (
        <div
          data-testid="voiceover-section"
          data-state={view}
          role="button"
          tabIndex={0}
          aria-expanded={false}
          title="Show voiceover"
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
          title="Not enough credits for this voiceover"
          subject="This"
          requiredCredits={error.requiredCredits}
          balanceCredits={error.balanceCredits}
        />
      )}
      {error?.kind === 'error' && (
        <span role="alert" data-testid="voiceover-error" className="text-small text-status-failed-fg">
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
