import './load-env'
import { createClient } from '@supabase/supabase-js'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type TestUser = Awaited<ReturnType<typeof createTestUser>>

/**
 * A throwaway, never-used auth user with a real session, minted via an admin-generated
 * magic link (no password needed, no existing account touched). The user comes from the
 * pool global-setup.ts pre-creates for full runs when one is left, and is created here
 * otherwise - a pooled user is exactly as fresh (created this run, never signed in, no
 * rows), only created earlier and off the test's own clock. The session is always minted
 * here, never pooled: pre-minting sessions in a burst trips Supabase's auth rate limit.
 * Returns the Playwright cookie to inject plus the user, so callers can assert ownership
 * and clean up afterward.
 */
export async function createTestSession() {
  const user = claimPooledUser() ?? (await createTestUser())
  const email = user.email!

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkError) throw new Error('generateLink failed: ' + JSON.stringify(linkError))

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: otpData, error: otpError } = await anon.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpError || !otpData.session) {
    throw new Error('verifyOtp failed: ' + JSON.stringify(otpError))
  }

  const ref = new URL(SUPABASE_URL).hostname.split('.')[0]
  const cookieName = `sb-${ref}-auth-token`
  const cookieValue =
    'base64-' + Buffer.from(JSON.stringify(otpData.session), 'utf8').toString('base64url')

  return {
    user,
    cookie: { name: cookieName, value: cookieValue, url: 'http://localhost:3000' },
    // Raw session, so a caller can build a second anon client scoped to this user
    // directly (auth.setSession) without decoding the cookie - used by RLS tests that
    // need two real, differently-scoped clients in the same process.
    session: otpData.session,
  }
}

async function createTestUser() {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: `pw-test-${crypto.randomUUID()}@reelcraft.local`,
    email_confirm: true,
    password: crypto.randomUUID(),
  })
  if (createError || !created.user) {
    throw new Error('createUser failed: ' + JSON.stringify(createError))
  }
  return created.user
}

export async function deleteTestUser(userId: string) {
  await admin.from('projects').delete().eq('user_id', userId)
  await admin.auth.admin.deleteUser(userId)
}

// The fresh-user pool: one file per unclaimed, never-signed-in user. Claiming renames the
// file, which is atomic across worker processes - a racing loser sees ENOENT and moves on.
const POOL_DIR = path.resolve(__dirname, '.auth/pool')
const CLAIMED_SUFFIX = '.claimed'

function claimPooledUser(): TestUser | null {
  let names: string[]
  try {
    names = readdirSync(POOL_DIR).filter((name) => name.endsWith('.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  for (const name of names) {
    const claimed = path.join(POOL_DIR, name + CLAIMED_SUFFIX)
    try {
      renameSync(path.join(POOL_DIR, name), claimed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    return JSON.parse(readFileSync(claimed, 'utf8')) as TestUser
  }
  return null
}

/** Clears the claim markers a run left behind (a claimed user belongs to the test that
 * claimed it, which cleans it up). Unclaimed users are kept: they are still never-signed-in
 * and row-free, so the next run takes them as they are. Returns the counts for the log. */
export async function pruneClaimedUsers(): Promise<{ claimed: number; unused: number }> {
  let names: string[]
  try {
    names = readdirSync(POOL_DIR)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { claimed: 0, unused: 0 }
    throw error
  }
  const claimed = names.filter((name) => name.endsWith(CLAIMED_SUFFIX))
  for (const name of claimed) rmSync(path.join(POOL_DIR, name), { force: true })
  return { claimed: claimed.length, unused: names.filter((name) => name.endsWith('.json')).length }
}

/** Tops the pool up to `size` unclaimed users, creating only the missing ones (no sessions),
 * a few at a time. Returns how many it created. */
export async function fillUserPool(size: number, concurrency = 8): Promise<number> {
  mkdirSync(POOL_DIR, { recursive: true })
  const existing = readdirSync(POOL_DIR).filter((name) => name.endsWith('.json')).length
  const missing = Math.max(0, size - existing)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, missing) }, async () => {
      while (next < missing) {
        next++
        const user = await createTestUser()
        writeFileSync(path.join(POOL_DIR, `${user.id}.json`), JSON.stringify(user))
      }
    })
  )
  return missing
}
