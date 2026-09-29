import type { MusicGateway } from '../../src/lib/music/gateway'
import { sampleAudio } from './voiceover-fakes'

// Hand-written MusicGateway fakes - no test ever reaches ElevenLabs. The audio is a real,
// decodable mp3 (the committed voice sample), because the pipeline measures the stored
// file's duration from the bytes.

export type ComposeCall = { prompt: string; lengthMs: number; model: string }

type FakeMusicGateway = MusicGateway & { composeCalls: ComposeCall[] }

export function successMusicGateway(): FakeMusicGateway {
  const composeCalls: ComposeCall[] = []
  return {
    composeCalls,
    async compose(params) {
      composeCalls.push({ ...params })
      return sampleAudio()
    },
  }
}

export function throwingMusicGateway(): FakeMusicGateway {
  const composeCalls: ComposeCall[] = []
  return {
    composeCalls,
    async compose(params) {
      composeCalls.push({ ...params })
      throw new Error('fake music provider failure')
    },
  }
}
