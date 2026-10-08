import { readFileSync } from 'node:fs'
import path from 'node:path'
import { VoiceoverProviderError, type AlignResult, type SynthesizeResult, type VoiceoverGateway } from '../../src/lib/voiceover/gateway'

// Hand-written VoiceoverGateway fakes - no test ever reaches ElevenLabs. The audio is a
// real, decodable mp3 (one of the committed voice samples), because the pipeline measures
// every part's duration from the audio itself.

const SAMPLE = path.resolve(__dirname, '../../public/voice-samples/en/JBFqnCBsd6RMkjVDRZzb.mp3')
// music-metadata's measurement of the sample above.
export const SAMPLE_SECONDS = 3.422040816326531

export function sampleAudio(): Buffer {
  return readFileSync(SAMPLE)
}

// Evenly spaced character times across the sample's length.
export function evenAlignment(text: string, seconds = SAMPLE_SECONDS) {
  const step = seconds / Math.max(1, text.length)
  return {
    characters: text.split(''),
    character_start_times_seconds: text.split('').map((_, i) => i * step),
    character_end_times_seconds: text.split('').map((_, i) => (i + 1) * step),
  }
}

export type SynthesizeCall = { text: string; voiceId: string; model: string; languageCode: string | null }

type FakeVoiceoverGateway = VoiceoverGateway & {
  synthesizeCalls: SynthesizeCall[]
  alignCalls: { text: string; mime: string; bytes: number }[]
}

/**
 * Succeeds on every call. The with-timestamps body carries BOTH blocks, and the
 * normalized one deliberately spells different text - reading it instead of `alignment`
 * would fail the pipeline's exact-text check.
 */
export function successVoiceoverGateway(options: { failSynthesizeOnCall?: number } = {}): FakeVoiceoverGateway {
  const synthesizeCalls: SynthesizeCall[] = []
  const alignCalls: { text: string; mime: string; bytes: number }[] = []
  return {
    synthesizeCalls,
    alignCalls,
    async synthesize(params): Promise<SynthesizeResult> {
      synthesizeCalls.push({ ...params })
      if (options.failSynthesizeOnCall === synthesizeCalls.length) throw new Error('fake provider failure')
      return {
        audio: sampleAudio(),
        timestamps: {
          alignment: evenAlignment(params.text),
          normalized_alignment: evenAlignment(params.text.toUpperCase() + ' NORMALIZED'),
        },
      }
    },
    async align(params): Promise<AlignResult> {
      alignCalls.push({ text: params.text, mime: params.mime, bytes: params.audio.length })
      const a = evenAlignment(params.text)
      return {
        characters: a.characters.map((c, i) => ({
          text: c,
          start: a.character_start_times_seconds[i],
          end: a.character_end_times_seconds[i],
        })),
      }
    },
  }
}

export function throwingVoiceoverGateway(): FakeVoiceoverGateway {
  const synthesizeCalls: SynthesizeCall[] = []
  const alignCalls: { text: string; mime: string; bytes: number }[] = []
  return {
    synthesizeCalls,
    alignCalls,
    async synthesize(params) {
      synthesizeCalls.push({ ...params })
      throw new Error('fake provider failure')
    },
    async align(params) {
      alignCalls.push({ text: params.text, mime: params.mime, bytes: params.audio.length })
      throw new Error('fake alignment failure')
    },
  }
}

/** What AbortSignal.timeout raises when the provider request runs past its timeout. */
export function providerTimeoutError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError')
}

/** Alignment that runs past the provider timeout. */
export function timeoutAlignVoiceoverGateway(): FakeVoiceoverGateway {
  const gateway = successVoiceoverGateway()
  return {
    ...gateway,
    async align(params) {
      gateway.alignCalls.push({ text: params.text, mime: params.mime, bytes: params.audio.length })
      throw providerTimeoutError()
    },
  }
}

/** Alignment the provider refuses with a 4xx (e.g. 429), before any alignment is made. */
export function rejectingAlignVoiceoverGateway(status: number): FakeVoiceoverGateway {
  const gateway = successVoiceoverGateway()
  return {
    ...gateway,
    async align(params) {
      gateway.alignCalls.push({ text: params.text, mime: params.mime, bytes: params.audio.length })
      throw new VoiceoverProviderError(status, 'rejected')
    },
  }
}

/**
 * Holds every synthesize call until `holdUntil` calls are in flight at once (or a short
 * fallback elapses, so a sequential pipeline fails the assertion instead of hanging), and
 * records the peak. `failWhen` picks the calls that fail after release.
 */
export function concurrentVoiceoverGateway(options: {
  holdUntil: number
  failWhen?: (text: string) => boolean
}): FakeVoiceoverGateway & { peakInFlight: () => number } {
  const base = successVoiceoverGateway()
  let inFlight = 0
  let peak = 0
  const waiters: (() => void)[] = []
  const releaseAll = () => waiters.splice(0).forEach((w) => w())
  return {
    ...base,
    peakInFlight: () => peak,
    async synthesize(params) {
      inFlight++
      peak = Math.max(peak, inFlight)
      if (inFlight >= options.holdUntil) releaseAll()
      else await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(releaseAll, 3000)
      })
      inFlight--
      if (options.failWhen?.(params.text)) {
        base.synthesizeCalls.push({ ...params })
        throw new Error('fake provider failure')
      }
      return base.synthesize(params)
    },
  }
}

/** Answers 429 (concurrent-request limit) to the first `times` calls, then succeeds. */
export function rateLimitedVoiceoverGateway(times: number): FakeVoiceoverGateway {
  const base = successVoiceoverGateway()
  let refused = 0
  return {
    ...base,
    async synthesize(params) {
      if (refused < times) {
        refused++
        base.synthesizeCalls.push({ ...params })
        throw new VoiceoverProviderError(429, 'concurrent_limit_exceeded')
      }
      return base.synthesize(params)
    },
  }
}
