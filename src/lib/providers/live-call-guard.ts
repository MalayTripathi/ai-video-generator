import type { Provider } from '@/lib/config/pipeline'

// The one decision point for whether a real, billed provider request may leave the
// process. Enforced twice per gateway: at the gateway method's entry, and again inside
// the `fetch` every provider client is constructed with (guardedFetch), so a request
// cannot reach the network by a path that forgot the entry check.
//
// BLOCK_PROVIDER_CALLS is the automated-run kill switch: any non-empty value other than
// '0' blocks every provider, regardless of NODE_ENV, and refuses the ALLOW_REAL_* opt-outs
// while it is set. Playwright sets it for every run and for the server it starts. With it
// unset, production passes and anything else needs its provider's ALLOW_REAL_* === '1' -
// a flag the developer sets by hand, never the repo.

export type GuardedProvider = Extract<Provider, 'anthropic' | 'openai' | 'elevenlabs'>

type Env = Record<string, string | undefined>

export const BLOCK_PROVIDER_CALLS = 'BLOCK_PROVIDER_CALLS'

export const ALLOW_FLAG: Record<GuardedProvider, string> = {
  anthropic: 'ALLOW_REAL_CLAUDE',
  openai: 'ALLOW_REAL_OPENAI_IMAGES',
  elevenlabs: 'ALLOW_REAL_ELEVENLABS',
}

const LABEL: Record<GuardedProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI image',
  elevenlabs: 'ElevenLabs',
}

function blockedMessage(provider: GuardedProvider, reason: 'block' | 'block_refused_opt_out' | 'no_opt_out'): string {
  const flag = ALLOW_FLAG[provider]
  const head = `Blocked a real, billed ${LABEL[provider]} call: `
  if (reason === 'block') {
    return head + `${BLOCK_PROVIDER_CALLS} is set, which blocks every provider call; ${flag} cannot lift it.`
  }
  if (reason === 'block_refused_opt_out') {
    return head + `${flag} was refused because ${BLOCK_PROVIDER_CALLS} is set, which blocks every provider call.`
  }
  return head + `live calls outside production require ${flag}=1, and this flag is set by the developer only.`
}

export class LiveCallsBlockedError extends Error {
  constructor(message = blockedMessage('anthropic', 'no_opt_out')) {
    super(message)
    this.name = 'LiveCallsBlockedError'
  }
}

export class ImageLiveCallsBlockedError extends Error {
  constructor(message = blockedMessage('openai', 'no_opt_out')) {
    super(message)
    this.name = 'ImageLiveCallsBlockedError'
  }
}

export class VoiceoverLiveCallsBlockedError extends Error {
  constructor(message = blockedMessage('elevenlabs', 'no_opt_out')) {
    super(message)
    this.name = 'VoiceoverLiveCallsBlockedError'
  }
}

const BLOCKED_ERROR: Record<GuardedProvider, new (message?: string) => Error> = {
  anthropic: LiveCallsBlockedError,
  openai: ImageLiveCallsBlockedError,
  elevenlabs: VoiceoverLiveCallsBlockedError,
}

export function providerCallsBlocked(env: Env = process.env): boolean {
  const value = env[BLOCK_PROVIDER_CALLS]
  return value !== undefined && value !== '' && value !== '0'
}

/** Throws the provider's typed blocked error unless a real call is permitted. `env` is
 * injectable so a test can exercise every branch without touching process.env. */
export function assertProviderCallAllowed(provider: GuardedProvider, env: Env = process.env): void {
  const optedIn = env[ALLOW_FLAG[provider]] === '1'
  if (providerCallsBlocked(env)) {
    throw new BLOCKED_ERROR[provider](blockedMessage(provider, optedIn ? 'block_refused_opt_out' : 'block'))
  }
  if (env.NODE_ENV === 'production') return
  if (optedIn) return
  throw new BLOCKED_ERROR[provider](blockedMessage(provider, 'no_opt_out'))
}

/** The `fetch` every provider client is built with: re-checks the guard on every request,
 * then delegates to the global fetch (resolved per call, never captured). */
export function guardedFetch(provider: GuardedProvider): typeof fetch {
  return (input, init) => {
    try {
      assertProviderCallAllowed(provider)
    } catch (error) {
      return Promise.reject(error)
    }
    return globalThis.fetch(input, init)
  }
}
