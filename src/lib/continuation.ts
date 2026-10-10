import { timingSafeEqual } from 'node:crypto'
import { serverEnv } from '@/lib/config/env.server'

// The shared secret a background run presents when it calls its own route again to
// continue past one invocation (storyboard images, shot generation). Such a request
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
