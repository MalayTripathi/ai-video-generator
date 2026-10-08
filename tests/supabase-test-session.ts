import './load-env'
import { createClient } from '@supabase/supabase-js'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { removeStorageUnder } from './storage-cleanup'

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
  // Registered before anything can use it, so a run killed before this user's own cleanup
  // leaves a record the next run's global-setup sweeps (sweepOrphanedTestUsers).
  mkdirSync(REGISTRY_DIR, { recursive: true })
  writeFileSync(path.join(REGISTRY_DIR, `${created.user.id}.json`), JSON.stringify({ id: created.user.id, email: created.user.email }))
  return created.user
}

/** Removes a minted user's files, projects and auth row, then its registry entry - the
 * entry only once the auth row is gone, so a failed delete is retried by the next sweep. */
export async function deleteTestUser(userId: string) {
  await removeStorageUnder(admin, userId).catch((err) => console.error(`[test-session] storage cleanup for ${userId} failed:`, err))
  await admin.from('projects').delete().eq('user_id', userId)
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (!error || error.status === 404) rmSync(path.join(REGISTRY_DIR, `${userId}.json`), { force: true })
}

// Every minted user, one file each, written at creation and removed by deleteTestUser.
const REGISTRY_DIR = path.resolve(__dirname, '.auth/minted')
const MINTED_EMAIL = /^pw-test-[0-9a-f-]{36}@reelcraft\.local$/

/**
 * Cleans up minted users an earlier run left behind - a run killed mid-test skips both the
 * test's own `finally` and globalTeardown. Candidates are registry entries plus any
 * signed-in minted account (pre-registry leftovers); unclaimed pool users are never
 * touched. Only addresses matching the minted pattern are deleted, re-checked against the
 * auth row, so a fixed or real user can never be swept. Runs from global-setup, before any
 * test of this run has minted anything.
 */
export async function sweepOrphanedTestUsers(): Promise<number> {
  const unclaimedPool = new Set(listJson(POOL_DIR))
  const candidates = new Set(listJson(REGISTRY_DIR))
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error('listUsers failed: ' + error.message)
    for (const u of data.users) if (u.last_sign_in_at && MINTED_EMAIL.test(u.email ?? '')) candidates.add(u.id)
    if (data.users.length < 1000) break
  }
  let swept = 0
  for (const id of candidates) {
    if (unclaimedPool.has(id)) continue
    const { data, error } = await admin.auth.admin.getUserById(id)
    if (error && error.status !== 404) continue
    if (data?.user && !MINTED_EMAIL.test(data.user.email ?? '')) continue
    await deleteTestUser(id)
    swept++
  }
  return swept
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
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
