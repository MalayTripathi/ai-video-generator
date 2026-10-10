import { test, expect } from '@playwright/test'
import { GET } from '../src/app/api/internal/provider-block/route'

// Layer: api. /api/internal/provider-block answers only on local, and only with the two block
// booleans tests/global-setup.ts reads - never a value, a key or a flag's contents.

test.describe('provider-block route', () => {
  let saved: string | undefined
  test.beforeEach(() => {
    saved = process.env.APP_ENV
  })
  test.afterEach(() => {
    if (saved === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = saved
  })

  for (const appEnv of ['preview', 'production']) {
    test(`is a 404 with no body on ${appEnv}`, async () => {
      process.env.APP_ENV = appEnv
      const res = GET()
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('')
    })
  }

  test('on local it returns exactly the two block booleans', async () => {
    process.env.APP_ENV = 'local'
    const body = await GET().json()
    expect(Object.keys(body).sort()).toEqual(['blocked', 'optOutsEmpty'])
    expect(typeof body.blocked).toBe('boolean')
    expect(typeof body.optOutsEmpty).toBe('boolean')
  })

  test('the server under test reports itself blocked, with nothing else in the body', async ({ request }) => {
    const res = await request.get('http://localhost:3000/api/internal/provider-block')
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ blocked: true, optOutsEmpty: true })
  })
})
