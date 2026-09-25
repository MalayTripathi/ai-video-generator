import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AlignResult, SynthesizeResult, VoiceoverGateway } from '../../src/lib/voiceover/gateway'

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
