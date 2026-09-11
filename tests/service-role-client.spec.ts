import './load-env'
import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// src/lib/supabase/service-role.ts imports the `server-only` package, which throws
// unconditionally unless resolved under the "react-server" export condition (the one
// Next.js's server bundler sets - see node_modules/server-only/package.json). That
// guard is exactly what's under test, so it can't be relaxed for a plain import here:
// importing the module directly in this file (which Playwright runs as ordinary
// Node, no "react-server" condition) would throw on the `import 'server-only'` line
// itself, before ever reaching createServiceRoleClient. Instead, each functional
// assertion below spawns a short-lived Node child process with
// `--conditions=react-server` - the same resolution Next's server bundle uses - so
// the *real* shipped file is exercised with its guard intact, without weakening it
// and without changing module resolution for the rest of the suite.

const MODULE_URL = 'file://' + path.resolve(__dirname, '../src/lib/supabase/service-role.ts')

function runInServerContext(envOverrides: Record<string, string | undefined>) {
  const script = `
    import(${JSON.stringify(MODULE_URL)}).then((m) => {
      try {
        const client = m.createServiceRoleClient()
        process.stdout.write(JSON.stringify({ ok: true, hasFrom: typeof client.from === 'function' }))
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, errorName: err && err.constructor && err.constructor.name }))
      }
    })
  `
  const env = { ...process.env }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }

  const result = spawnSync(process.execPath, ['--conditions=react-server', '-e', script], {
    env,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`child process failed: ${result.stderr}`)
  }
  return JSON.parse(result.stdout.trim())
}

test.describe('createServiceRoleClient', () => {
  test('throws MissingServiceRoleKeyError when SUPABASE_SERVICE_ROLE_KEY is unset, never falling back', async () => {
    const output = runInServerContext({ SUPABASE_SERVICE_ROLE_KEY: undefined })
    expect(output.ok).toBe(false)
    expect(output.errorName).toBe('MissingServiceRoleKeyError')
  })

  test('returns a client when the key is present', async () => {
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeTruthy()
    const output = runInServerContext({})
    expect(output.ok).toBe(true)
    expect(output.hasFrom).toBe(true)
  })
})

test.describe('service-role client isolation', () => {
  test('no barrel file re-exports it, and nothing outside this spec imports it yet', async () => {
    const supabaseDir = path.resolve(__dirname, '../src/lib/supabase')
    const noBarrel = readdirSync(supabaseDir).every((f) => !/^index\.tsx?$/.test(f))
    expect(noBarrel).toBe(true)

    const srcDir = path.resolve(__dirname, '../src')
    const ownFile = path.resolve(__dirname, '../src/lib/supabase/service-role.ts')
    function findImporters(dir: string): string[] {
      const hits: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          hits.push(...findImporters(full))
        } else if (/\.(ts|tsx)$/.test(entry) && full !== ownFile) {
          const contents = readFileSync(full, 'utf8')
          if (contents.includes('supabase/service-role')) hits.push(full)
        }
      }
      return hits
    }
    expect(findImporters(srcDir)).toEqual([])
  })
})
