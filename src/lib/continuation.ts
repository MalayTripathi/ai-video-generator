import { timingSafeEqual } from 'node:crypto'

// The shared secret a background run presents when it calls its own route again to
// continue past one invocation (storyboard images, shot generation). Such a request
// carries no user session, so this is its only credential. One env value for every
// chain; each route names its own header.
export function continuationSecret(): string | undefined {
  return process.env.INTERNAL_CONTINUATION_SECRET || undefined
}

/** Constant-time check of a presented secret. An unconfigured secret matches nothing. */
export function continuationSecretMatches(provided: string): boolean {
  const expected = continuationSecret()
  if (!expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
