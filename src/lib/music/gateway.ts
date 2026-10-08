import { MUSIC_REQUEST_TIMEOUT_MS } from '@/lib/config/storyboard'
import { assertLiveVoiceoverCallsAllowed } from '@/lib/voiceover/gateway'
import { guardedFetch } from '@/lib/providers/live-call-guard'

// The one place ElevenLabs Music is called. Server-side only: the key never reaches a
// client. Every request goes through guardedFetch. Tests inject hand-written fakes instead of this (tests/helpers/music-fakes.ts).

const providerFetch = guardedFetch('elevenlabs')

const API_BASE = 'https://api.elevenlabs.io'
const OUTPUT_FORMAT = 'mp3_44100_128'

export interface MusicGateway {
  /** Instrumental music from a style prompt (POST /v1/music). Returns the mp3 bytes. */
  compose(params: { prompt: string; lengthMs: number; model: string }): Promise<Buffer>
}

/** A non-2xx answer from the provider. Carries the status; never matched by message. */
export class MusicProviderError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`ElevenLabs music returned ${status}: ${detail}`)
    this.name = 'MusicProviderError'
    this.status = status
  }
}

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')
  return key
}

export function createMusicGateway(): MusicGateway {
  return {
    async compose(params) {
      // Same provider, same live-call guard as the voiceover (ALLOW_REAL_ELEVENLABS).
      assertLiveVoiceoverCallsAllowed()
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[music] LIVE call outside production — provider=elevenlabs model=${params.model} ms=${params.lengthMs}`)
      }

      // One request, no retry: a retried request is a second charge.
      const res = await providerFetch(`${API_BASE}/v1/music?output_format=${OUTPUT_FORMAT}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: params.prompt,
          music_length_ms: params.lengthMs,
          model_id: params.model,
          force_instrumental: true,
        }),
        signal: AbortSignal.timeout(MUSIC_REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new MusicProviderError(res.status, body.slice(0, 300))
      }
      const audio = Buffer.from(await res.arrayBuffer())
      if (audio.length === 0) throw new Error('ElevenLabs returned no music')
      return audio
    },
  }
}
