const SHOT_KEY_ALPHABET = '23456789bcdfghjkmnpqrstvwxz'
const SHOT_KEY_LENGTH = 5
const UNIQUE_VIOLATION = '23505'

export function generateShotKey(): string {
  let key = ''
  for (let i = 0; i < SHOT_KEY_LENGTH; i++) {
    key += SHOT_KEY_ALPHABET[Math.floor(Math.random() * SHOT_KEY_ALPHABET.length)]
  }
  return key
}

/** Generates `count` keys with no collisions within the batch itself. */
export function generateUniqueShotKeys(count: number): string[] {
  const keys = new Set<string>()
  while (keys.size < count) {
    keys.add(generateShotKey())
  }
  return [...keys]
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

/**
 * 27^5 (~14.3M) combinations per project - a same-project collision against
 * the (project_id, shot_key) unique constraint is vanishingly unlikely.
 * This bound exists for correctness, not because it's expected to fire.
 */
export const MAX_SHOT_KEY_INSERT_ATTEMPTS = 5
