import { MusicProviderError, type MusicGateway } from '../../src/lib/music/gateway'
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

/** A compose request that runs past the provider timeout (what AbortSignal.timeout raises). */
export function timeoutMusicGateway(): FakeMusicGateway {
  const composeCalls: ComposeCall[] = []
  return {
    composeCalls,
    async compose(params) {
      composeCalls.push({ ...params })
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    },
  }
}

/** A compose request the provider refuses with a 4xx (e.g. 429), before any audio is made. */
export function rejectingMusicGateway(status: number): FakeMusicGateway {
  const composeCalls: ComposeCall[] = []
  return {
    composeCalls,
    async compose(params) {
      composeCalls.push({ ...params })
      throw new MusicProviderError(status, 'rejected')
    },
  }
}
