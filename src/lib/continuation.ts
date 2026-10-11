import { timingSafeEqual } from 'node:crypto'
import { serverEnv } from '@/lib/config/env.server'

// The shared secret a background run presents when it calls its own route again to
// continue past one invocation (storyboard images, shot generation), or to start a chain in
// its own invocation (the agent's regenerate_all_shots). Such a request
// carries no user session, so this is its only credential. One env value for every
// chain; each route names its own header. Required at boot (env.ts class A).
export function continuationSecret(): string {
  return serverEnv().continuationSecret
}

/** Constant-time check of a presented secret. */
export function continuationSecretMatches(provided: string): boolean {
  const expected = continuationSecret()
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Vercel's header for "Protection Bypass for Automation". A protected deployment (every
// preview) answers a self-call without it with its login page, so the hand-off is refused.
const DEPLOYMENT_BYPASS_HEADER = 'x-vercel-protection-bypass'

/** The headers a chain's call to its own route needs to get through deployment protection. */
export function deploymentBypassHeaders(): Record<string, string> {
  const secret = serverEnv().deploymentBypassSecret
  return secret ? { [DEPLOYMENT_BYPASS_HEADER]: secret } : {}
}
