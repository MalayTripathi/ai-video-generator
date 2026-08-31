import { readFileSync } from 'node:fs'
import path from 'node:path'

const AUTH_DIR = path.resolve(__dirname, '.auth')

export const PRIMARY_STORAGE_STATE = path.join(AUTH_DIR, 'primary.storageState.json')
export const SECONDARY_STORAGE_STATE = path.join(AUTH_DIR, 'secondary.storageState.json')

export type FixedIdentity = {
  user: { id: string; email: string }
  session: { access_token: string; refresh_token: string }
}

function readIdentity(name: 'primary' | 'secondary'): FixedIdentity {
  const filePath = path.join(AUTH_DIR, `${name}.session.json`)
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    throw new Error(
      `${filePath} is missing. tests/global-setup.ts writes this before any spec runs - ` +
        'this file should never be read outside a Playwright run driven by playwright.config.ts.'
    )
  }
}

/**
 * The suite's two persistent, reused-across-runs test identities, minted once per run
 * by global-setup.ts (see its module docblock). Import `primary`/`secondary` instead of
 * calling createTestSession() unless the spec genuinely needs a fresh, never-attempted
 * user - see CLAUDE.md's Testing section for which specs qualify and why.
 */
export const primary = readIdentity('primary')
export const secondary = readIdentity('secondary')
