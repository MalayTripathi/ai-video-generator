import './load-env'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/**
 * Creates a throwaway auth user and mints a real session for it via an
 * admin-generated magic link (no password needed, no existing account
 * touched). Returns the Playwright cookie to inject plus the user, so
 * callers can assert ownership and clean up afterward.
 */
export async function createTestSession() {
  const email = `pw-test-${crypto.randomUUID()}@reelcraft.local`
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: crypto.randomUUID(),
  })
  if (createError || !created.user) {
    throw new Error('createUser failed: ' + JSON.stringify(createError))
  }
  const user = created.user

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

export async function deleteTestUser(userId: string) {
  await admin.from('projects').delete().eq('user_id', userId)
  await admin.auth.admin.deleteUser(userId)
}
