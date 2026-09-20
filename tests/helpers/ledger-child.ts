import { spawn } from 'node:child_process'
import path from 'node:path'
import type { recordDynamicSpend } from '../../src/lib/credits/ledger'
import { admin } from '../supabase-test-session'

// src/lib/credits/ledger.ts imports src/lib/supabase/service-role.ts, which imports the
// `server-only` package - importing ledger.ts directly from a Playwright spec (plain Node,
// no "react-server" export condition) would throw before reaching a ledger function. So
// each call spawns a short-lived Node child with --conditions=react-server and imports the
// real .ts source, which means a test exercises the production recordDynamicSpend rather
// than a reimplementation of its rounding/dedupe logic (tests/ledger.spec.ts covers that).
const MODULE_URL = 'file://' + path.resolve(__dirname, '../../src/lib/credits/ledger.ts')
const SIGNUP_GRANT_MODULE_URL = 'file://' + path.resolve(__dirname, '../../src/lib/credits/signup-grant.ts')
const ALIAS_LOADER_URL = 'file://' + path.resolve(__dirname, 'ts-alias-loader.mjs')

type LedgerCallResult =
  | { ok: true; result: unknown }
  | { ok: false; errorName: string | undefined; message: string }

function runModuleCall(moduleUrl: string, fn: string, arg: unknown): Promise<LedgerCallResult> {
  const script = `
    const { register } = require('node:module')
    register(${JSON.stringify(ALIAS_LOADER_URL)})
    import(${JSON.stringify(moduleUrl)}).then(async (m) => {
      try {
        const result = await m[${JSON.stringify(fn)}](${JSON.stringify(arg)})
        process.stdout.write(JSON.stringify({ ok: true, result: result === undefined ? null : result }))
      } catch (err) {
        process.stdout.write(JSON.stringify({
          ok: false,
          errorName: err && err.constructor && err.constructor.name,
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    })
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=react-server', '-e', script], { env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ledger child process exited ${code}: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout.trim()))
    })
  })
}

export const realRecordDynamicSpend: typeof recordDynamicSpend = async (params) => {
  const result = await runModuleCall(MODULE_URL, 'recordDynamicSpend', params)
  if (!result.ok) {
    throw new Error(`recordDynamicSpend failed: ${result.errorName}: ${result.message}`)
  }
}

/**
 * A user's balance as the app computes it: the signup grant materialized first (the layout
 * does this on every authenticated page load; a plain-Node test has no page load, so it is
 * done explicitly through the real ensureSignupGrant), then SUM(delta) over the ledger.
 *
 * credits/balance.ts's getBalance cannot be called from here - it builds its client with
 * next/headers cookies, which needs a real request context - so the sum is read directly
 * with the service-role `admin` client. It is the same one-line query, against the same table.
 */
export async function grantAndReadBalance(userId: string): Promise<number> {
  const grant = await runModuleCall(SIGNUP_GRANT_MODULE_URL, 'ensureSignupGrant', userId)
  if (!grant.ok) {
    throw new Error(`ensureSignupGrant failed: ${grant.errorName}: ${grant.message}`)
  }
  const { data, error } = await admin.from('credit_ledger').select('delta').eq('user_id', userId)
  if (error) throw new Error(`balance read failed: ${error.message}`)
  return (data ?? []).reduce((sum, row) => sum + row.delta, 0)
}
