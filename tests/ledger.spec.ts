import './load-env'
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { usdToCredits, SIGNUP_GRANT_CREDITS } from '../src/lib/config/credits'

// src/lib/credits/ledger.ts imports src/lib/supabase/service-role.ts, which imports
// the `server-only` package - so directly importing ledger.ts here (plain Node, no
// "react-server" export condition) would throw on that import before ever reaching a
// ledger function, exactly like Task 3's service-role-client.spec.ts. Same fix,
// generalized: spawn a short-lived Node child process per call with
// `--conditions=react-server`, dynamically import() the real .ts source, and invoke
// the requested export by name. A "concurrent" test spawns two of these processes at
// once - genuine OS-level concurrency against the DB, not just two in-process
// promises racing on a single connection pool.

const MODULE_URL = 'file://' + path.resolve(__dirname, '../src/lib/credits/ledger.ts')
const ALIAS_LOADER_URL = 'file://' + path.resolve(__dirname, 'helpers/ts-alias-loader.mjs')

type LedgerCallResult =
  | { ok: true; result: unknown }
  | { ok: false; errorName: string | undefined; message: string }

function runLedgerCall(fn: string, arg: unknown): Promise<LedgerCallResult> {
  const script = `
    const { register } = require('node:module')
    register(${JSON.stringify(ALIAS_LOADER_URL)})
    import(${JSON.stringify(MODULE_URL)}).then(async (m) => {
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

// ensureSignupGrant lives in credits/signup-grant.ts now (split out of the ledger so
// that a balance READ - credits/balance.ts - never has to import anything
// service-role-flavored; see the module-hygiene block below). Same service-role
// transitive-import problem, same spawn-a-child-process fix, just pointed at the new
// file.
const SIGNUP_GRANT_MODULE_URL = 'file://' + path.resolve(__dirname, '../src/lib/credits/signup-grant.ts')

function runSignupGrantCall(fn: string, arg: unknown): Promise<LedgerCallResult> {
  const script = `
    const { register } = require('node:module')
    register(${JSON.stringify(ALIAS_LOADER_URL)})
    import(${JSON.stringify(SIGNUP_GRANT_MODULE_URL)}).then(async (m) => {
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
        reject(new Error(`signup-grant child process exited ${code}: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout.trim()))
    })
  })
}

test.describe('ensureSignupGrant', () => {
  test('a fresh user gets exactly one signup_grant row and the configured grant value', async () => {
    const { user } = await createTestSession()
    try {
      const result = await runSignupGrantCall('ensureSignupGrant', user.id)
      expect(result.ok).toBe(true)

      const { data } = await admin.from('credit_ledger').select('*').eq('user_id', user.id)
      expect(data).toHaveLength(1)
      expect(data![0].kind).toBe('signup_grant')
      expect(data![0].delta).toBe(SIGNUP_GRANT_CREDITS)
      expect(data![0].dedupe_key).toBe(`signup_grant:${user.id}`)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('calling ensureSignupGrant twice on a fresh user does not create a second grant row', async () => {
    const { user } = await createTestSession()
    try {
      await runSignupGrantCall('ensureSignupGrant', user.id)
      await runSignupGrantCall('ensureSignupGrant', user.id)

      const { data } = await admin
        .from('credit_ledger')
        .select('id')
        .eq('user_id', user.id)
        .eq('kind', 'signup_grant')
      expect(data).toHaveLength(1)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('two concurrent ensureSignupGrant calls on a fresh user produce exactly one grant row', async () => {
    const { user } = await createTestSession()
    try {
      const [r1, r2] = await Promise.all([
        runSignupGrantCall('ensureSignupGrant', user.id),
        runSignupGrantCall('ensureSignupGrant', user.id),
      ])
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      const { data } = await admin
        .from('credit_ledger')
        .select('id')
        .eq('user_id', user.id)
        .eq('kind', 'signup_grant')
      expect(data).toHaveLength(1)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

test.describe('recordFixedSpend', () => {
  test('writes delta negative, pricing_mode fixed, and the dedupe_key shape "{operation}:{attemptId}"', async () => {
    const { user } = await createTestSession()
    try {
      const attemptId = crypto.randomUUID()
      const result = await runLedgerCall('recordFixedSpend', {
        userId: user.id,
        step: 'workbench',
        operation: 'generate_shots',
        quantity: 8,
        attemptId,
        projectId: null,
      })
      expect(result.ok).toBe(true)

      const { data } = await admin
        .from('credit_ledger')
        .select('*')
        .eq('user_id', user.id)
        .eq('kind', 'spend')
        .single()
      expect(data!.delta).toBeLessThan(0)
      expect(data!.pricing_mode).toBe('fixed')
      expect(data!.dedupe_key).toBe(`generate_shots:${attemptId}`)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('calling recordFixedSpend twice with the same attemptId produces exactly one row and does not throw', async () => {
    const { user } = await createTestSession()
    try {
      const attemptId = crypto.randomUUID()
      const params = {
        userId: user.id,
        step: 'workbench',
        operation: 'generate_shots',
        quantity: 8,
        attemptId,
        projectId: null,
      }
      const first = await runLedgerCall('recordFixedSpend', params)
      const second = await runLedgerCall('recordFixedSpend', params)
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)

      const { data } = await admin.from('credit_ledger').select('id').eq('user_id', user.id).eq('kind', 'spend')
      expect(data).toHaveLength(1)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

test.describe('recordDynamicSpend', () => {
  test('a usd value rounding to 0 writes no row', async () => {
    const { user } = await createTestSession()
    try {
      const result = await runLedgerCall('recordDynamicSpend', {
        userId: user.id,
        usd: 0,
        step: 'workbench',
        operation: 'agent_turn',
        attemptId: crypto.randomUUID(),
        projectId: null,
      })
      expect(result.ok).toBe(true)

      const { data } = await admin.from('credit_ledger').select('id').eq('user_id', user.id)
      expect(data).toHaveLength(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('rounds once on the total: a summed call charges strictly less than summing per-call conversions would', async () => {
    const { user } = await createTestSession()
    try {
      // Three provider calls of $0.0003 each. Converted separately (the wrong way),
      // each rounds up to its own credit before being summed. Converted once on the
      // total (the required way), the sum rounds up only once. This is the exact
      // saving recordDynamicSpend's "round once, on the total" rule exists to capture -
      // built from the real usdToCredits rather than hardcoded numbers, so the example
      // stays valid if USD_PER_CREDIT ever changes.
      const perCallUsd = 0.0003
      const perCallTotal = usdToCredits(perCallUsd) * 3
      const summedUsd = perCallUsd * 3
      const expectedOnceRounded = usdToCredits(summedUsd)
      expect(expectedOnceRounded).toBeLessThan(perCallTotal)

      const result = await runLedgerCall('recordDynamicSpend', {
        userId: user.id,
        usd: summedUsd,
        step: 'workbench',
        operation: 'agent_turn',
        attemptId: crypto.randomUUID(),
        projectId: null,
      })
      expect(result.ok).toBe(true)

      const { data } = await admin
        .from('credit_ledger')
        .select('delta')
        .eq('user_id', user.id)
        .single()
      expect(-data!.delta).toBe(expectedOnceRounded)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

test.describe('recordRefund', () => {
  test('inserts a positive inverse, leaves the original row byte-identical, and sets refunds_ledger_id', async () => {
    const { user } = await createTestSession()
    try {
      const attemptId = crypto.randomUUID()
      await runLedgerCall('recordFixedSpend', {
        userId: user.id,
        step: 'workbench',
        operation: 'generate_shots',
        quantity: 8,
        attemptId,
        projectId: null,
      })
      const { data: before } = await admin
        .from('credit_ledger')
        .select('*')
        .eq('user_id', user.id)
        .eq('kind', 'spend')
        .single()

      const result = await runLedgerCall('recordRefund', { userId: user.id, ledgerId: before!.id })
      expect(result.ok).toBe(true)

      const { data: after } = await admin.from('credit_ledger').select('*').eq('id', before!.id).single()
      expect(after).toEqual(before)

      const { data: refundRow } = await admin
        .from('credit_ledger')
        .select('*')
        .eq('user_id', user.id)
        .eq('kind', 'refund')
        .single()
      expect(refundRow!.delta).toBe(-before!.delta)
      expect(refundRow!.refunds_ledger_id).toBe(before!.id)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('refunding the same row twice does not produce a second refund', async () => {
    const { user } = await createTestSession()
    try {
      const attemptId = crypto.randomUUID()
      await runLedgerCall('recordFixedSpend', {
        userId: user.id,
        step: 'workbench',
        operation: 'generate_shots',
        quantity: 8,
        attemptId,
        projectId: null,
      })
      const { data: spend } = await admin
        .from('credit_ledger')
        .select('id')
        .eq('user_id', user.id)
        .eq('kind', 'spend')
        .single()

      const first = await runLedgerCall('recordRefund', { userId: user.id, ledgerId: spend!.id })
      const second = await runLedgerCall('recordRefund', { userId: user.id, ledgerId: spend!.id })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(false)
      expect(!second.ok && second.errorName).toBe('DuplicateRefundError')

      const { data: refunds } = await admin
        .from('credit_ledger')
        .select('id')
        .eq('user_id', user.id)
        .eq('kind', 'refund')
      expect(refunds).toHaveLength(1)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test("throws a named error for another user's row", async () => {
    const { user: userA } = await createTestSession()
    const { user: userB } = await createTestSession()
    try {
      const attemptId = crypto.randomUUID()
      await runLedgerCall('recordFixedSpend', {
        userId: userA.id,
        step: 'workbench',
        operation: 'generate_shots',
        quantity: 8,
        attemptId,
        projectId: null,
      })
      const { data: spend } = await admin
        .from('credit_ledger')
        .select('id')
        .eq('user_id', userA.id)
        .eq('kind', 'spend')
        .single()

      const result = await runLedgerCall('recordRefund', { userId: userB.id, ledgerId: spend!.id })
      expect(result.ok).toBe(false)
      expect(!result.ok && result.errorName).toBe('InvalidRefundTargetError')
    } finally {
      await deleteTestUser(userA.id)
      await deleteTestUser(userB.id)
    }
  })
})

test.describe('module hygiene', () => {
  test('no .update() or .delete() against credit_ledger anywhere in the module', async () => {
    const contents = readFileSync(path.resolve(__dirname, '../src/lib/credits/ledger.ts'), 'utf8')
    expect(contents).not.toMatch(/\.update\(/)
    expect(contents).not.toMatch(/\.delete\(/)
  })

  test('exactly the agent/shots/camera/elements/image-prompts spend wiring imports this module - nothing else', async () => {
    // Task 5 (wire agent_turn to the ledger) was this module's first legitimate
    // caller; Task 6 (wire generate_shots and derive_camera) added two more of the
    // same shape, plus a fourth (generate_element_reference, the first non-Claude
    // paid call); C6 Task 3 (image-prompts, the first route with a real balance gate
    // and a partial-persistence-aware charge) added a fifth. Each route (agent/route.ts,
    // shots/route.ts, camera/route.ts, elements/.../generate/route.ts,
    // image-prompts/route.ts) imports mintAttemptId/recordDynamicSpend/
    // recordFixedSpend for real (it runs inside Next's server bundle, so the
    // service-role.ts -> 'server-only' chain this module pulls in is safe there), and
    // each corresponding logic.ts carries only a **type-only** `import type` for its
    // DI parameters' types - erased at compile time, so it adds no runtime dependency
    // (confirmed: tests that import a logic.ts directly, like
    // tests/agent-turn.spec.ts/tests/shot-generation.spec.ts/
    // tests/camera-derivation.spec.ts, do so from plain Node with no "react-server"
    // condition and do not throw).
    //
    // workbench/actions.ts is deliberately NOT in this list. It used to import
    // getBalance from here for the Assets-tab affordance read, on the theory that
    // being a 'use server' module in the same server bundle as the routes above made
    // it equally safe - that theory was wrong: tests/shot-deletion.spec.ts
    // dynamically import()s actions.ts directly, in plain Node with no
    // "react-server" condition, which broke the instant this module gained a real
    // caller outside a route. getBalance now lives in credits/balance.ts (ordinary
    // client, no service-role in its import graph at all), so actions.ts no longer
    // has any reason to reference this module. video-prompts is also deliberately NOT
    // in this list - that route has no ledger wiring; if it ever imports this module,
    // this test should catch it. Any importer beyond these ten means a second,
    // unreviewed call site.
    const srcDir = path.resolve(__dirname, '../src')
    const ownFile = path.resolve(__dirname, '../src/lib/credits/ledger.ts')
    const expectedImporters = [
      path.resolve(__dirname, '../src/app/api/projects/[id]/agent/logic.ts'),
      path.resolve(__dirname, '../src/app/api/projects/[id]/agent/route.ts'),
      path.resolve(__dirname, '../src/app/api/projects/[id]/shots/logic.ts'),
      path.resolve(__dirname, '../src/app/api/projects/[id]/shots/route.ts'),
      path.resolve(__dirname, '../src/app/api/projects/[id]/shots/[shotId]/camera/logic.ts'),
      path.resolve(__dirname, '../src/app/api/projects/[id]/shots/[shotId]/camera/route.ts'),
      path.resolve(
        __dirname,
        '../src/app/api/projects/[id]/elements/[elementId]/reference/generate/logic.ts'
      ),
      path.resolve(
        __dirname,
        '../src/app/api/projects/[id]/elements/[elementId]/reference/generate/route.ts'
      ),
      path.resolve(__dirname, '../src/app/api/projects/[id]/image-prompts/logic.ts'),
      path.resolve(__dirname, '../src/app/api/projects/[id]/image-prompts/route.ts'),
    ].sort()
    function findImporters(dir: string): string[] {
      const hits: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          hits.push(...findImporters(full))
        } else if (/\.(ts|tsx)$/.test(entry) && full !== ownFile) {
          const contents = readFileSync(full, 'utf8')
          if (contents.includes('credits/ledger')) hits.push(full)
        }
      }
      return hits
    }
    expect(findImporters(srcDir).sort()).toEqual(expectedImporters)
  })

  test('credits/balance.ts (the balance read) never imports the service-role client', async () => {
    const contents = readFileSync(path.resolve(__dirname, '../src/lib/credits/balance.ts'), 'utf8')
    expect(contents).not.toMatch(/supabase\/service-role|createServiceRoleClient/)
  })

  test('credits/signup-grant.ts (the grant write) uses the service-role client', async () => {
    const contents = readFileSync(path.resolve(__dirname, '../src/lib/credits/signup-grant.ts'), 'utf8')
    expect(contents).toMatch(/service-role/)
  })
})
