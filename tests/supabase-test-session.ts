import './load-env'
import { createClient } from '@supabase/supabase-js'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { removeStorageUnder } from '@/lib/storage/sweep'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type TestUser = Awaited<ReturnType<typeof createTestUser>>

/**
 * A pool user with no rows, given a real session via an admin-generated magic link (no
 * password needed, no existing account touched). Users come only from the fixed-size pool
 * global-setup.ts fills; no test ever creates one. A released user is wiped of every row it
 * owns, so it is as fresh as a new one for anything a test can read. The session is always
 * minted here, never pooled: pre-minting sessions in a burst trips Supabase's auth rate
 * limit. Returns the Playwright cookie to inject plus the user, so callers can assert
 * ownership and release it afterward with releaseTestUser.
 */
export async function createTestSession() {
  const user = await claimPoolUser()
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

/**
 * A pool user with no rows and no session - for a spec that only needs its own user id (its
 * own projects, ledger and monthly spend) and never signs in. No magic link is minted, so it
 * does not count against the auth rate limit createTestSession is bound by. Release it with
 * releaseTestUser.
 */
export async function createFreshUser() {
  return claimPoolUser()
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

/**
 * Wipes every row a pool user owns and returns it to the pool. usage and credit_ledger go
 * first, by user_id: their project_id is a plain id that a project delete never touches
 * (the global-teardown order). The signup grant is lazy and dedupe-keyed, so the
 * next claim starts from a fresh grant. A failed wipe keeps the user claimed - global setup
 * retries it - rather than handing the next test a user with rows.
 */
export async function releaseTestUser(userId: string) {
  if (!(await wipeUserRows(userId))) return
  try {
    renameSync(path.join(POOL_DIR, `${userId}.json${CLAIMED_SUFFIX}`), path.join(POOL_DIR, `${userId}.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function wipeUserRows(userId: string): Promise<boolean> {
  let ok = true
  for (const table of ['usage', 'credit_ledger', 'exports', 'projects', 'deleted_projects'] as const) {
    const { error } = await admin.from(table).delete().eq('user_id', userId)
    if (error) {
      console.error(`[test-session] ${table} cleanup for ${userId} failed:`, error.message)
      ok = false
    }
  }
  await removeStorageUnder(admin, userId).catch((err) => {
    console.error(`[test-session] storage cleanup for ${userId} failed:`, err)
    ok = false
  })
  return ok
}

/** Removes a minted user that is not in the pool: files, projects and auth row, then its
 * registry entry - the entry only once the auth row is gone, so a failed delete is retried by
 * the next sweep. Only the orphan sweep uses it; tests release their users instead. */
async function deleteTestUser(userId: string) {
  await removeStorageUnder(admin, userId).catch((err) => console.error(`[test-session] storage cleanup for ${userId} failed:`, err))
  await admin.from('projects').delete().eq('user_id', userId)
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (!error || error.status === 404) rmSync(path.join(REGISTRY_DIR, `${userId}.json`), { force: true })
}

// Every minted user, one file each, written at creation and removed by deleteTestUser.
// Pool users stay registered for as long as they stay in the pool.
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
  const pool = new Set([...listJson(POOL_DIR), ...listClaimed()])
  const candidates = new Set(listJson(REGISTRY_DIR))
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error('listUsers failed: ' + error.message)
    for (const u of data.users) if (u.last_sign_in_at && MINTED_EMAIL.test(u.email ?? '')) candidates.add(u.id)
    if (data.users.length < 1000) break
  }
  let swept = 0
  for (const id of candidates) {
    if (pool.has(id)) continue
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

// The user pool: one file per user, '{id}.json' while free and '{id}.json.claimed' while a
// test holds it. Claiming renames the file, which is atomic across worker processes - a
// racing loser sees ENOENT and moves on. Its size is fixed at USER_POOL_MAX: tests wait for
// a released user rather than create one.
const POOL_DIR = path.resolve(__dirname, '.auth/pool')
const CLAIMED_SUFFIX = '.claimed'
export const USER_POOL_MAX = 38
const POOL_CLAIM_POLL_MS = 250
const POOL_CLAIM_TIMEOUT_MS = 60_000

async function claimPoolUser(): Promise<TestUser> {
  const deadline = Date.now() + POOL_CLAIM_TIMEOUT_MS
  for (;;) {
    const user = claimFreeUser()
    if (user) return user
    if (Date.now() >= deadline) {
      throw new Error(`User pool exhausted: no free user in ${POOL_DIR} after ${POOL_CLAIM_TIMEOUT_MS / 1000}s (pool size ${USER_POOL_MAX}; tests never create users)`)
    }
    await new Promise((resolve) => setTimeout(resolve, POOL_CLAIM_POLL_MS))
  }
}

function listClaimed(): string[] {
  try {
    return readdirSync(POOL_DIR).filter((name) => name.endsWith(CLAIMED_SUFFIX)).map((name) => name.slice(0, -`.json${CLAIMED_SUFFIX}`.length))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function claimFreeUser(): TestUser | null {
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

/** Releases the users a run left claimed - a killed test never reached its own release - so
 * the pool keeps its size. Returns the counts for the log. */
export async function pruneClaimedUsers(): Promise<{ claimed: number; unused: number }> {
  const claimed = listClaimed()
  for (const id of claimed) await releaseTestUser(id)
  return { claimed: claimed.length, unused: listJson(POOL_DIR).length }
}

/** Tops the pool up to USER_POOL_MAX users, free or claimed, creating only the missing ones
 * (no sessions), a few at a time - never beyond the maximum. Returns how many it created. */
export async function fillUserPool(concurrency = 8): Promise<number> {
  mkdirSync(POOL_DIR, { recursive: true })
  const existing = listJson(POOL_DIR).length + listClaimed().length
  const missing = Math.max(0, USER_POOL_MAX - existing)
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
