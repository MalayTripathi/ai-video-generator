import { VOICEOVER_REQUEST_TIMEOUT_MS, VOICEOVER_SYNTH_TIMEOUT_MS } from '@/lib/config/storyboard'
import { assertProviderCallAllowed, guardedFetch, VoiceoverLiveCallsBlockedError } from '@/lib/providers/live-call-guard'
import { isProduction } from '@/lib/config/env'
import { serverEnv } from '@/lib/config/env.server'

export { VoiceoverLiveCallsBlockedError }

// The one place ElevenLabs is called, always through guardedFetch. Server-side only: the key never reaches a client.
// Tests inject hand-written fakes instead of this (tests/helpers/voiceover-fakes.ts).

const providerFetch = guardedFetch('elevenlabs')

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

/** A non-2xx answer from the provider. Carries the status; never matched by message. */
export class VoiceoverProviderError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`ElevenLabs returned ${status}: ${detail}`)
    this.name = 'VoiceoverProviderError'
    this.status = status
  }
}

// The Anthropic guard's twin (src/lib/providers/live-call-guard.ts). Never set, export, or
// add ALLOW_REAL_ELEVENLABS anywhere in this repo's own env files, npm scripts, test
// config, or CI - whether to spend money on a live call is the developer's decision alone.
export function assertLiveVoiceoverCallsAllowed(): void {
  assertProviderCallAllowed('elevenlabs')
}

function apiKey(): string {
  return serverEnv().providerKeys.elevenlabs
}

async function failure(res: Response): Promise<VoiceoverProviderError> {
  const body = await res.text().catch(() => '')
  return new VoiceoverProviderError(res.status, body.slice(0, 300))
}

export function createVoiceoverGateway(): VoiceoverGateway {
  return {
    async synthesize(params) {
      assertLiveVoiceoverCallsAllowed()
      if (!isProduction()) {
        console.warn(`[voiceover] LIVE call on local — provider=elevenlabs model=${params.model} chars=${params.text.length}`)
      }

      // One request, no retry here: a retried request is a second charge. The worker retries
      // only a 429, which is refused before any audio is made.
      const res = await providerFetch(
        `${API_BASE}/v1/text-to-speech/${encodeURIComponent(params.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: params.text,
            model_id: params.model,
            ...(params.languageCode ? { language_code: params.languageCode } : {}),
          }),
          signal: AbortSignal.timeout(VOICEOVER_SYNTH_TIMEOUT_MS),
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
      if (!isProduction()) {
        console.warn(`[voiceover] LIVE call on local — provider=elevenlabs forced-alignment bytes=${params.audio.length}`)
      }

      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(params.audio)], { type: params.mime }), params.fileName)
      form.append('text', params.text)
      const res = await providerFetch(`${API_BASE}/v1/forced-alignment`, {
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
