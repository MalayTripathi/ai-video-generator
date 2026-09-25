import { VOICEOVER_REQUEST_TIMEOUT_MS } from '@/lib/config/storyboard'

// The one place ElevenLabs is called. Server-side only: the key never reaches a client.
// Tests inject hand-written fakes instead of this (tests/helpers/voiceover-fakes.ts).

const API_BASE = 'https://api.elevenlabs.io'
const OUTPUT_FORMAT = 'mp3_44100_128'

export type SynthesizeResult = {
  audio: Buffer
  /** The whole response body minus the audio - readAlignment picks `alignment` out of it. */
  timestamps: unknown
}

export type ForcedAlignmentCharacter = { text: string; start: number; end: number }

export type AlignResult = {
  characters: ForcedAlignmentCharacter[]
}

export interface VoiceoverGateway {
  /** Text-to-speech with character timestamps (POST /v1/text-to-speech/{voice}/with-timestamps). */
  synthesize(params: { text: string; voiceId: string; model: string; languageCode: string | null }): Promise<SynthesizeResult>
  /** Forced alignment of existing audio against its text (POST /v1/forced-alignment). */
  align(params: { audio: Buffer; mime: string; fileName: string; text: string }): Promise<AlignResult>
}

export class VoiceoverLiveCallsBlockedError extends Error {
  constructor() {
    super(
      'Blocked a real, billed ElevenLabs call: live calls outside production require ' +
        'ALLOW_REAL_ELEVENLABS=1, and this flag is set by the developer only.'
    )
    this.name = 'VoiceoverLiveCallsBlockedError'
  }
}

/** A non-2xx answer from the provider. Carries the status; never matched by message. */
export class VoiceoverProviderError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`ElevenLabs returned ${status}: ${detail}`)
    this.name = 'VoiceoverProviderError'
    this.status = status
  }
}

// Mirrors assertLiveImageCallsAllowed (src/lib/images/gateway.ts) exactly. Never set,
// export, or add ALLOW_REAL_ELEVENLABS anywhere in this repo's own env files, npm scripts,
// test config, or CI - whether to spend money on a live call is the developer's decision
// alone.
export function assertLiveVoiceoverCallsAllowed(): void {
  if (process.env.NODE_ENV === 'production') return
  if (process.env.ALLOW_REAL_ELEVENLABS === '1') return
  throw new VoiceoverLiveCallsBlockedError()
}

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')
  return key
}

async function failure(res: Response): Promise<VoiceoverProviderError> {
  const body = await res.text().catch(() => '')
  return new VoiceoverProviderError(res.status, body.slice(0, 300))
}

export function createVoiceoverGateway(): VoiceoverGateway {
  return {
    async synthesize(params) {
      assertLiveVoiceoverCallsAllowed()
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[voiceover] LIVE call outside production — provider=elevenlabs model=${params.model} chars=${params.text.length}`)
      }

      // One request, no retry: a retried request is a second charge.
      const res = await fetch(
        `${API_BASE}/v1/text-to-speech/${encodeURIComponent(params.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: params.text,
            model_id: params.model,
            ...(params.languageCode ? { language_code: params.languageCode } : {}),
          }),
          signal: AbortSignal.timeout(VOICEOVER_REQUEST_TIMEOUT_MS),
        }
      )
      if (!res.ok) throw await failure(res)
      const body = (await res.json()) as { audio_base64?: unknown } & Record<string, unknown>
      if (typeof body.audio_base64 !== 'string' || body.audio_base64 === '') {
        throw new Error('ElevenLabs returned no audio')
      }
      const { audio_base64, ...timestamps } = body
      return { audio: Buffer.from(audio_base64, 'base64'), timestamps }
    },

    async align(params) {
      assertLiveVoiceoverCallsAllowed()
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[voiceover] LIVE call outside production — provider=elevenlabs forced-alignment bytes=${params.audio.length}`)
      }

      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(params.audio)], { type: params.mime }), params.fileName)
      form.append('text', params.text)
      const res = await fetch(`${API_BASE}/v1/forced-alignment`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey() },
        body: form,
        signal: AbortSignal.timeout(VOICEOVER_REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) throw await failure(res)
      const body = (await res.json()) as { characters?: unknown }
      if (!Array.isArray(body.characters)) throw new Error('ElevenLabs returned no character alignment')
      const characters = body.characters.flatMap((c) => {
        const ch = c as Partial<ForcedAlignmentCharacter>
        return typeof ch.text === 'string' && typeof ch.start === 'number' && typeof ch.end === 'number'
          ? [{ text: ch.text, start: ch.start, end: ch.end }]
          : []
      })
      return { characters }
    },
  }
}
