import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/database.types'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { runAdvanceToStoryboard } from '../src/app/api/projects/[id]/storyboard/advance/logic'
import { runAdvanceToImagePrompts } from '../src/app/api/projects/[id]/image_prompts/advance/logic'
import { loadImageStatuses } from '../src/app/api/projects/[id]/images/status/logic'
import { loadEditableProject } from '../src/app/api/projects/[id]/voiceover/logic'

// A project read that fails is an error, never "not found": a genuine missing (or
// unowned) project stays a 404, a failed query becomes a 500. The failure here is real,
// not faked - a client whose bearer token PostgREST rejects gets an error back from every
// read, exactly as a database or auth outage would surface. Nothing here spends: every
// path under test returns before any balance check or provider call.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const failing = createClient<Database>(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { headers: { Authorization: 'Bearer not-a-valid-jwt' } },
})

async function otherUser() {
  const client = createClient<Database>(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await client.auth.setSession(secondary.session)
  expect(error).toBeNull()
  return client
}

async function seedProject() {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Project read errors',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

// exports/logic.ts imports the service-role client ('server-only'), so - as with
// helpers/ledger-child.ts - its calls run in a short-lived Node child under the
// react-server condition, against the real source.
const EXPORTS_URL = 'file://' + path.resolve(__dirname, '../src/app/api/projects/[id]/exports/logic.ts')
const ALIAS_LOADER_URL = 'file://' + path.resolve(__dirname, 'helpers/ts-alias-loader.mjs')

function exportsStatuses(projectId: string, userId: string): Promise<Record<string, { ok: boolean; status: number }>> {
  const script = `
    const { register } = require('node:module')
    register(${JSON.stringify(ALIAS_LOADER_URL)})
    const { createClient } = require('@supabase/supabase-js')
    import(${JSON.stringify(EXPORTS_URL)}).then(async (m) => {
      const env = JSON.parse(process.env.PRE_ARGS)
      const opts = { auth: { autoRefreshToken: false, persistSession: false } }
      const failing = createClient(env.url, env.anon, { ...opts, global: { headers: { Authorization: 'Bearer not-a-valid-jwt' } } })
      const stranger = createClient(env.url, env.anon, opts)
      await stranger.auth.setSession(env.session)
      const service = createClient(env.url, env.service, opts)
      const base = { service, projectId: env.projectId, userId: env.userId }
      const out = {}
      for (const [label, supabase] of [['failing', failing], ['stranger', stranger]]) {
        const loaded = await m.loadExports({ ...base, supabase })
        out['loadExports:' + label] = { ok: loaded.ok, status: loaded.status }
        const cancelled = await m.cancelExport({ ...base, supabase, exportId: env.exportId })
        out['cancelExport:' + label] = { ok: cancelled.ok, status: cancelled.status }
      }
      process.stdout.write(JSON.stringify(out))
    })
  `
  const args = {
    url: SUPABASE_URL,
    anon: ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    session: secondary.session,
    projectId,
    userId,
    exportId: crypto.randomUUID(),
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=react-server', '-e', script], {
      env: { ...process.env, PRE_ARGS: JSON.stringify(args) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`exports child exited ${code}: ${stderr}`))))
  })
}

const neverBalance = async () => {
  throw new Error('the balance must not be read before the project read is settled')
}
const neverGrant = async () => {
  throw new Error('no grant may be attempted before the project read is settled')
}

test('a failed project read is a 500 and a missing project is a 404, across the logic modules', async () => {
  const projectId = await seedProject()
  const userId = primary.user.id
  const stranger = await otherUser()

  // The failure is genuine: PostgREST itself rejects this client.
  const probe = await failing.from('projects').select('id').eq('id', projectId).maybeSingle()
  expect(probe.error).not.toBeNull()

  const cases: { name: string; run: (supabase: typeof failing) => Promise<{ ok: boolean; status?: number }> }[] = [
    {
      name: 'runAdvanceToStoryboard',
      run: (supabase) => runAdvanceToStoryboard({ supabase, projectId, userId, getBalance: neverBalance, ensureSignupGrant: neverGrant }),
    },
    {
      name: 'runAdvanceToImagePrompts',
      run: (supabase) => runAdvanceToImagePrompts({ supabase, projectId, userId, getBalance: neverBalance, ensureSignupGrant: neverGrant }),
    },
    {
      name: 'loadImageStatuses',
      run: (supabase) => loadImageStatuses({ supabase, projectId, userId, getBalance: async () => 0 }),
    },
    {
      name: 'loadEditableProject',
      run: async (supabase) => {
        const result = await loadEditableProject(supabase, projectId, userId)
        return 'ok' in result ? result : { ok: true }
      },
    },
  ]

  for (const { name, run } of cases) {
    const failed = await run(failing)
    expect(failed.ok, name).toBe(false)
    expect(failed.status, name).toBe(500)

    // The same call as a signed-in user who doesn't own the project: a genuine not-found.
    const missing = await run(stranger)
    expect(missing.ok, name).toBe(false)
    expect(missing.status, name).toBe(404)
  }

  const exportsResults = await exportsStatuses(projectId, userId)
  for (const name of ['loadExports', 'cancelExport']) {
    expect(exportsResults[`${name}:failing`], name).toEqual({ ok: false, status: 500 })
    expect(exportsResults[`${name}:stranger`], name).toEqual({ ok: false, status: 404 })
  }
})
