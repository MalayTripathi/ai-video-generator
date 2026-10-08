import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { createTestSession, deleteTestUser } from './supabase-test-session'

// The session boundary as a request sees it: the proxy refreshes an expired access token
// from the refresh token and hands the page the new cookie; pages redirect a signed-out
// visitor to /login; API routes answer 401. Cookie-less contexts are built explicitly so
// the config's default storageState (primary) never leaks in. The expired-session cases
// use a fresh user, since a refresh rotates the refresh token and would break primary's
// stored session for every other spec.

const BASE_URL = 'http://localhost:3000'

let anon: APIRequestContext
test.beforeAll(async () => {
  anon = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } })
})
test.afterAll(async () => {
  await anon.dispose()
})

type Session = Awaited<ReturnType<typeof createTestSession>>['session']

function cookieHeader(name: string, session: Session) {
  return `${name}=base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`
}

// A page with a loading.tsx streams, so its redirect() arrives in the body of a 200 (Next's
// refresh meta tag) rather than as a 3xx; either form is a redirect to /login.
async function expectLoginRedirect(res: Awaited<ReturnType<APIRequestContext['get']>>) {
  if (res.status() >= 300 && res.status() < 400) {
    expect(new URL(res.headers()['location'], BASE_URL).pathname).toBe('/login')
    return
  }
  expect(res.status()).toBe(200)
  const body = await res.text()
  expect(body).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*url=\/login"/)
}

function expired(session: Session): Session {
  const past = Math.floor(Date.now() / 1000) - 3600
  return { ...session, expires_at: past, expires_in: -3600 }
}

test('a signed-out visit to the dashboard redirects to /login', async () => {
  await expectLoginRedirect(await anon.get('/dashboard', { maxRedirects: 0 }))
})

test('a signed-out API request is refused with 401', async () => {
  const res = await anon.get(`/api/projects/${crypto.randomUUID()}/images/status`, { maxRedirects: 0 })
  expect(res.status()).toBe(401)
})

test.describe('an expired access token', () => {
  test('is refreshed by the proxy: the page renders signed in and the response carries the new cookie', async () => {
    const { user, cookie, session } = await createTestSession()
    try {
      const res = await anon.get('/dashboard', {
        maxRedirects: 0,
        headers: { cookie: cookieHeader(cookie.name, expired(session)) },
      })
      expect(res.status()).toBe(200)
      expect(await res.text()).not.toMatch(/http-equiv="refresh"[^>]*url=\/login/)
      const setCookies = res
        .headersArray()
        .filter((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith(`${cookie.name}=`))
      expect(setCookies.length).toBeGreaterThan(0)
      const refreshed = setCookies[0].value.split(';')[0].slice(cookie.name.length + 1)
      expect(refreshed.startsWith('base64-')).toBe(true)
      const parsed = JSON.parse(Buffer.from(refreshed.slice('base64-'.length), 'base64url').toString('utf8'))
      expect(parsed.refresh_token).not.toBe(session.refresh_token)
      expect(parsed.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('with an unusable refresh token redirects to /login', async () => {
    const { user, cookie, session } = await createTestSession()
    try {
      const res = await anon.get('/dashboard', {
        maxRedirects: 0,
        headers: { cookie: cookieHeader(cookie.name, { ...expired(session), refresh_token: 'not-a-real-token' }) },
      })
      await expectLoginRedirect(res)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
