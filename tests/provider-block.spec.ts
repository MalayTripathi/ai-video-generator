import { test, expect } from '@playwright/test'
import { createClaudeGateway, LiveCallsBlockedError } from '../src/lib/claude'
import { createImageGateway, ImageLiveCallsBlockedError } from '../src/lib/images/gateway'
import { createVoiceoverGateway, VoiceoverLiveCallsBlockedError } from '../src/lib/voiceover/gateway'
import { createMusicGateway } from '../src/lib/music/gateway'
import { assertProviderCallAllowed, guardedFetch } from '../src/lib/providers/live-call-guard'

// Layer: api. The provider block (src/lib/providers/live-call-guard.ts) must hold under
// APP_ENV=production - where the per-provider opt-outs are not needed and every call would
// otherwise pass. Each real gateway is driven with dummy keys
// and a global fetch that records and throws, so a guard regression is a failed
// assertion here, never a real request.

// Test-only mutation, restored below.
const env = process.env as Record<string, string | undefined>
const SAVED_KEYS = ['APP_ENV', 'BLOCK_PROVIDER_CALLS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY']

test.describe('provider block under APP_ENV=production', () => {
  let saved: Record<string, string | undefined>
  let realFetch: typeof fetch
  let networkCalls: string[]

  test.beforeEach(() => {
    saved = Object.fromEntries(SAVED_KEYS.map((key) => [key, env[key]]))
    env.APP_ENV = 'production'
    env.BLOCK_PROVIDER_CALLS = '1'
    env.ANTHROPIC_API_KEY = 'blocked-test-key'
    env.OPENAI_API_KEY = 'blocked-test-key'
    env.ELEVENLABS_API_KEY = 'blocked-test-key'
    realFetch = globalThis.fetch
    networkCalls = []
    globalThis.fetch = async (input) => {
      networkCalls.push(String(input instanceof Request ? input.url : input))
      throw new Error('a provider request reached the network layer')
    }
  })

  test.afterEach(() => {
    globalThis.fetch = realFetch
    for (const key of SAVED_KEYS) {
      if (saved[key] === undefined) delete env[key]
      else env[key] = saved[key]
    }
  })

  test('Anthropic: a real createMessage is refused', { tag: '@smoke' }, async () => {
    const call = createClaudeGateway().createMessage({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'never sent' }],
    })
    await expect(call).rejects.toBeInstanceOf(LiveCallsBlockedError)
    expect(networkCalls).toEqual([])
  })

  test('OpenAI images: real storyboard and reference generations are refused', { tag: '@smoke' }, async () => {
    const gateway = createImageGateway()
    const common = { prompt: 'never sent', model: 'gpt-image-1', quality: 'low', size: '1024x1024' }
    await expect(gateway.generateStoryboardImage({ ...common, references: [] })).rejects.toBeInstanceOf(
      ImageLiveCallsBlockedError
    )
    await expect(gateway.generateReferenceImage(common)).rejects.toBeInstanceOf(ImageLiveCallsBlockedError)
    expect(networkCalls).toEqual([])
  })

  test('ElevenLabs: real synthesis, alignment and music are refused', { tag: '@smoke' }, async () => {
    const voiceover = createVoiceoverGateway()
    await expect(
      voiceover.synthesize({ text: 'never sent', voiceId: 'v', model: 'eleven_v3', languageCode: null })
    ).rejects.toBeInstanceOf(VoiceoverLiveCallsBlockedError)
    await expect(
      voiceover.align({ audio: Buffer.from([0]), mime: 'audio/mpeg', fileName: 'a.mp3', text: 'never sent' })
    ).rejects.toBeInstanceOf(VoiceoverLiveCallsBlockedError)
    await expect(
      createMusicGateway().compose({ prompt: 'never sent', lengthMs: 10_000, model: 'music_v1' })
    ).rejects.toBeInstanceOf(VoiceoverLiveCallsBlockedError)
    expect(networkCalls).toEqual([])
  })

  test('the transport-level fetch refuses on its own, before the network', async () => {
    await expect(guardedFetch('anthropic')('https://example.invalid/')).rejects.toBeInstanceOf(LiveCallsBlockedError)
    await expect(guardedFetch('openai')('https://example.invalid/')).rejects.toBeInstanceOf(ImageLiveCallsBlockedError)
    await expect(guardedFetch('elevenlabs')('https://example.invalid/')).rejects.toBeInstanceOf(
      VoiceoverLiveCallsBlockedError
    )
    expect(networkCalls).toEqual([])
  })
})

// The decision itself, over literal environments - never process.env - so the opt-out
// branches are exercised without an opt-out flag ever being set in this process.
test.describe('assertProviderCallAllowed decision', () => {
  test('an opt-out is refused while the block is set, in production and out', { tag: '@smoke' }, () => {
    expect(() =>
      assertProviderCallAllowed('anthropic', { BLOCK_PROVIDER_CALLS: '1', ALLOW_REAL_CLAUDE: '1', APP_ENV: 'production' })
    ).toThrow(LiveCallsBlockedError)
    expect(() =>
      assertProviderCallAllowed('openai', { BLOCK_PROVIDER_CALLS: '1', ALLOW_REAL_OPENAI_IMAGES: '1', APP_ENV: 'local' })
    ).toThrow(ImageLiveCallsBlockedError)
    expect(() =>
      assertProviderCallAllowed('elevenlabs', { BLOCK_PROVIDER_CALLS: 'yes', ALLOW_REAL_ELEVENLABS: '1', APP_ENV: 'production' })
    ).toThrow(VoiceoverLiveCallsBlockedError)
  })

  test('with the block off, production passes and development needs the exact opt-out', () => {
    expect(() => assertProviderCallAllowed('anthropic', { APP_ENV: 'production' })).not.toThrow()
    expect(() => assertProviderCallAllowed('anthropic', { APP_ENV: 'production', BLOCK_PROVIDER_CALLS: '0' })).not.toThrow()
    expect(() => assertProviderCallAllowed('anthropic', { APP_ENV: 'local' })).toThrow(LiveCallsBlockedError)
    expect(() => assertProviderCallAllowed('anthropic', { APP_ENV: 'local', ALLOW_REAL_CLAUDE: '0' })).toThrow(
      LiveCallsBlockedError
    )
    expect(() => assertProviderCallAllowed('elevenlabs', { APP_ENV: 'local', ALLOW_REAL_ELEVENLABS: '1' })).not.toThrow()
  })
})
