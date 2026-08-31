import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const AUTH_DIR = path.resolve(__dirname, '.auth')

const PRIMARY_EMAIL = 'pw-fixed-primary@reelcraft.local'
const SECONDARY_EMAIL = 'pw-fixed-secondary@reelcraft.local'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getOrCreateFixedUser(admin: any, email: string) {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: crypto.randomUUID(),
  })
  if (!createError && created.user) return created.user

  if (createError && !/already.*(registered|exists)/i.test(createError.message ?? '')) {
    throw new Error(`getOrCreateFixedUser(${email}) createUser failed: ${createError.message}`)
  }

  // Already exists from a prior run - find it instead of failing. No raw SQL against
  // auth.users; this stays within the supabase-js Admin SDK.
  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`getOrCreateFixedUser(${email}) listUsers failed: ${error.message}`)
    const found = data.users.find((u: { email?: string }) => u.email === email)
    if (found) return found
    if (data.users.length < 200) break
    page++
  }
  throw new Error(`getOrCreateFixedUser(${email}): not found after createUser reported a duplicate`)
}

async function mintSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  supabaseUrl: string,
  anonKey: string,
  email: string
) {
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkError) throw new Error(`generateLink(${email}) failed: ${JSON.stringify(linkError)}`)

  const { createClient } = await import('@supabase/supabase-js')
  const anon = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: otpData, error: otpError } = await anon.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpError || !otpData.session) throw new Error(`verifyOtp(${email}) failed: ${JSON.stringify(otpError)}`)
  return otpData.session
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildStorageState(session: any, supabaseUrl: string) {
  const ref = new URL(supabaseUrl).hostname.split('.')[0]
  const cookieName = `sb-${ref}-auth-token`
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
  return {
    cookies: [
      {
        name: cookieName,
        value: cookieValue,
        domain: 'localhost',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  }
}

export default async function globalSetup() {
  if (process.env.ALLOW_REAL_CLAUDE === '1') {
    throw new Error(
      'ALLOW_REAL_CLAUDE=1 is set. This suite must never make a real, billed Anthropic call. ' +
        'Unset ALLOW_REAL_CLAUDE before running the Playwright suite. The only sanctioned way to ' +
        'make a live call is `npm run dev` with ALLOW_REAL_CLAUDE=1 exported by hand in your own ' +
        'shell, outside Playwright entirely.'
    )
  }

  // Deliberately dynamic, and deliberately after the guard above. load-env.ts's module
  // evaluation deletes ALLOW_REAL_CLAUDE from process.env as one of its own side effects
  // (so a value left in .env.local from a manual live-debugging session can't leak into
  // the spawned dev server). A static top-level import here would be hoisted and
  // evaluated before the guard check above runs, silently deleting the flag before it
  // could ever be observed - never make this a static import.
  await import('./load-env')

  const { createClient } = await import('@supabase/supabase-js')
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  mkdirSync(AUTH_DIR, { recursive: true })

  const identities: { name: 'primary' | 'secondary'; email: string }[] = [
    { name: 'primary', email: PRIMARY_EMAIL },
    { name: 'secondary', email: SECONDARY_EMAIL },
  ]

  // Exactly two verifyOtp round trips per run, regardless of how many spec files or
  // tests exist - this is the fix for Supabase's hosted auth rate limit, which the old
  // per-test createTestSession() pattern exhausted (~45 verifyOtp calls per full run).
  for (const { name, email } of identities) {
    const user = await getOrCreateFixedUser(admin, email)
    const session = await mintSession(admin, SUPABASE_URL, ANON_KEY, email)

    writeFileSync(
      path.join(AUTH_DIR, `${name}.storageState.json`),
      JSON.stringify(buildStorageState(session, SUPABASE_URL))
    )
    writeFileSync(
      path.join(AUTH_DIR, `${name}.session.json`),
      JSON.stringify({
        user: { id: user.id, email: user.email },
        session: { access_token: session.access_token, refresh_token: session.refresh_token },
      })
    )
  }
}
