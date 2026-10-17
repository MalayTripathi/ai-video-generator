import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { admin, createTestSession, releaseTestUser } from './supabase-test-session'
import { primary, secondary, SECONDARY_STORAGE_STATE } from './fixed-users'
import { releaseStaleHolds } from '../src/lib/credits/release-stale-holds'
import { deleteProject } from '../src/lib/projects/delete-project'
import { readProjectMetas } from '../src/lib/projects/project-meta'
import { aggregateCreditsPeriod } from '../src/app/(app)/credits/aggregate'
import { listObjectsUnder } from '../src/lib/storage/sweep'
import type { Database } from '../src/lib/database.types'
import type { Step, Operation } from '../src/lib/config/pipeline'

// Project deletion through DELETE /api/projects/[id], against real rows: credit_ledger and
// usage survive untouched, nothing live or held may be deleted from under, a dead run's hold
// is released first, storage under the project's prefix is swept, and the delete path is
// closed to clients. Specs that read a balance or a user's holds claim a wiped pool user;
// the rest use primary and assert only on their own project's rows.

const BASE_URL = 'http://localhost:3000'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const STALE = new Date(Date.now() - 20 * 60_000).toISOString()

// First hits compile the route on the dev server, which is slow under a parallel run.
test.setTimeout(90000)

const KEY_CHARS = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]).join('')

const pool: string[] = []
test.afterAll(async () => {
  for (const id of pool) await releaseTestUser(id)
})

async function poolSession(): Promise<{ userId: string; api: APIRequestContext }> {
  const { user, cookie } = await createTestSession()
  pool.push(user.id)
  const api = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: {
      cookies: [{ ...cookie, domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [],
    },
  })
  return { userId: user.id, api }
}

async function seedProject(userId: string, title = 'Deletion spec') {
  const { data: project, error } = await admin
    .from('projects')
    .insert({ user_id: userId, title, source_text: 'A short film.', duration_target: '30-60s' })
    .select('id, created_at')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id
  const { data: shot, error: shotError } = await admin
    .from('shots')
    .insert({ project_id: projectId, order_index: 0, shot_key: shotKey(), voice_over: 'A line.', visual_description: 'A visual.' })
    .select('id')
    .single()
  expect(shotError).toBeNull()
  const { data: message } = await admin
    .from('messages')
    .insert({ project_id: projectId, role: 'user', content: 'hello' })
    .select('id')
    .single()
  const { data: generation } = await admin
    .from('generations')
    .insert({ project_id: projectId, step: 'workbench', operation: 'generate_shots', shot_id: null, element_id: null, state: 'succeeded' })
    .select('id')
    .single()
  // Files at several depths, including a replaced image beside the current one.
  const files = [
    `${userId}/${projectId}/images/${shot!.id}/a.webp`,
    `${userId}/${projectId}/images/${shot!.id}/old.webp`,
    `${userId}/${projectId}/voiceover/v.mp3`,
    `${userId}/${projectId}/exports/e1/film.mp4`,
  ]
  for (const path of files) {
    const { error: uploadError } = await admin.storage.from('artifacts').upload(path, Buffer.from('x'), { contentType: 'application/octet-stream' })
    expect(uploadError).toBeNull()
  }
  return { projectId, createdAt: project!.created_at, shotId: shot!.id, messageId: message!.id, generationId: generation!.id }
}

const spend = (userId: string, projectId: string, extra: Record<string, unknown> = {}) => {
  const attemptId = crypto.randomUUID()
  return {
    user_id: userId,
    kind: 'spend',
    delta: -10,
    step: 'workbench' as Step,
    operation: 'agent_turn' as Operation,
    project_id: projectId,
    message_id: null,
    shot_key: null,
    attempt_id: attemptId,
    dedupe_key: `agent_turn:${attemptId}`,
    hold_slot: null,
    price_version: 'test',
    pricing_mode: 'dynamic',
    refunds_ledger_id: null,
    ...extra,
  }
}

const hold = (userId: string, projectId: string, attemptId: string, slot: number, createdAt?: string) => ({
  ...spend(userId, projectId),
  delta: -16,
  operation: 'generate_shots' as Operation,
  attempt_id: attemptId,
  dedupe_key: `hold:${attemptId}`,
  hold_slot: slot,
  pricing_mode: 'fixed',
  ...(createdAt ? { created_at: createdAt } : {}),
})

async function balanceOf(userId: string) {
  const { data } = await admin.from('credit_balances').select('balance, open_hold_live_at').eq('user_id', userId).maybeSingle()
  return data
}

test.describe('project deletion route', () => {
  test('deletes the project and its files; every ledger and usage row survives unchanged and late charges still land', { tag: '@smoke' }, async () => {
    const { userId, api } = await poolSession()
    const seeded = await seedProject(userId)
    const { projectId } = seeded
    const { data: ledgerRows, error: ledgerError } = await admin
      .from('credit_ledger')
      .insert([spend(userId, projectId, { message_id: seeded.messageId }), spend(userId, projectId)])
      .select('*')
    expect(ledgerError).toBeNull()
    const { data: usageRows, error: usageError } = await admin
      .from('usage')
      .insert({
        user_id: userId,
        project_id: projectId,
        shot_id: seeded.shotId,
        generation_id: seeded.generationId,
        message_id: seeded.messageId,
        step: 'workbench',
        operation: 'agent_turn',
        provider: 'anthropic',
        model: 'test',
        status: 'succeeded',
        estimated_cost: 0.02,
        quoted_cost: 0.05,
      })
      .select('*')
    expect(usageError).toBeNull()
    const before = await balanceOf(userId)

    const response = await api.delete(`/api/projects/${projectId}`)
    expect(response.status()).toBe(200)

    const [{ data: live }, { data: record }, { data: ledgerAfter }, { data: usageAfter }] = await Promise.all([
      admin.from('projects').select('id').eq('id', projectId).maybeSingle(),
      admin.from('deleted_projects').select('*').eq('id', projectId).maybeSingle(),
      admin.from('credit_ledger').select('*').in('id', ledgerRows!.map((r) => r.id)),
      admin.from('usage').select('*').in('id', usageRows!.map((r) => r.id)),
    ])
    expect(live).toBeNull()
    expect(record).toMatchObject({ user_id: userId, title: 'Deletion spec', shot_count: 1, duration_tier: '30-60s', furthest_step: 1 })
    expect(new Date(record!.created_at).getTime()).toBe(new Date(seeded.createdAt).getTime())
    expect(record!.storage_purged_at).not.toBeNull()
    // Unchanged, field for field: project_id, message_id, shot_id, generation_id intact.
    expect(ledgerAfter!.sort((a, b) => a.id.localeCompare(b.id))).toEqual(ledgerRows!.sort((a, b) => a.id.localeCompare(b.id)))
    expect(usageAfter).toEqual(usageRows)
    expect((await balanceOf(userId))?.balance).toBe(before?.balance)
    expect(await listObjectsUnder(admin, `${userId}/${projectId}`)).toEqual([])

    // A charge that lands after the delete still writes: no foreign key refuses it.
    const late = await admin.from('credit_ledger').insert(spend(userId, projectId, { message_id: seeded.messageId }))
    expect(late.error).toBeNull()
    const lateUsage = await admin.from('usage').insert({ ...usageRows![0], id: undefined, created_at: undefined })
    expect(lateUsage.error).toBeNull()

    // The redirect for a deleted project's URL streams (loading.tsx), so it is asserted in a
    // browser - tests/project-deletion-ui.spec.ts.
  })

  for (const busy of ['claim', 'shot_run', 'export', 'hold'] as const) {
    test(`refuses with 409 and changes nothing while a ${busy} is live`, async ({ request }) => {
      const { projectId } = await seedProject(primary.user.id, `Busy ${busy}`)
      const now = new Date().toISOString()
      if (busy === 'claim') {
        const { error } = await admin.from('generations').insert({
          project_id: projectId, step: 'image_prompts', operation: 'write_image_prompts', shot_id: null, element_id: null, state: 'generating', started_at: now,
        })
        expect(error).toBeNull()
      } else if (busy === 'shot_run') {
        const { error } = await admin.from('shot_runs').insert({ project_id: projectId, attempt_id: crypto.randomUUID(), kind: 'generate', status: 'running', heartbeat_at: now })
        expect(error).toBeNull()
      } else if (busy === 'export') {
        const { error } = await admin.from('exports').insert({ user_id: primary.user.id, project_id: projectId, status: 'queued', settings: {}, film_hash: 'deletion-spec' })
        expect(error).toBeNull()
      } else {
        // A hold whose run finished moments ago and is not yet charged: open, and inside its
        // stale window, so nothing may settle it yet.
        const attemptId = crypto.randomUUID()
        const { error: runError } = await admin.from('shot_runs').insert({
          project_id: projectId, attempt_id: attemptId, kind: 'generate', status: 'completed', heartbeat_at: now, finished_at: now,
        })
        expect(runError).toBeNull()
        const { data: slots } = await admin.from('credit_ledger').select('hold_slot').eq('user_id', primary.user.id).not('hold_slot', 'is', null)
        const slot = Math.max(1000, ...(slots ?? []).map((r) => r.hold_slot ?? 0)) + 1 + Math.floor(Math.random() * 1000)
        const { error } = await admin.from('credit_ledger').insert(hold(primary.user.id, projectId, attemptId, slot))
        expect(error).toBeNull()
      }
      const { count: ledgerBefore } = await admin.from('credit_ledger').select('id', { count: 'exact', head: true }).eq('project_id', projectId)

      const response = await request.delete(`/api/projects/${projectId}`)
      expect(response.status()).toBe(409)
      expect((await response.json()).code).toBe('active')

      const [{ data: live }, { data: record }, { count: ledgerAfter }] = await Promise.all([
        admin.from('projects').select('id').eq('id', projectId).maybeSingle(),
        admin.from('deleted_projects').select('id').eq('id', projectId).maybeSingle(),
        admin.from('credit_ledger').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
      ])
      expect(live).not.toBeNull()
      expect(record).toBeNull()
      expect(ledgerAfter).toBe(ledgerBefore)
      expect((await listObjectsUnder(admin, `${primary.user.id}/${projectId}`)).length).toBe(4)
      // Leave nothing queued for a running worker.
      await admin.from('exports').update({ status: 'cancelled' }).eq('project_id', projectId).eq('status', 'queued')
    })
  }

  test('a dead hold is refunded before the delete, and a hold charged at exactly its amount is never refunded after it', async () => {
    const { userId, api } = await poolSession()
    const { projectId } = await seedProject(userId)
    // Dead: placed long ago, and its run never started.
    const deadAttempt = crypto.randomUUID()
    const { data: deadHold, error: deadError } = await admin.from('credit_ledger').insert(hold(userId, projectId, deadAttempt, 1, STALE)).select('id').single()
    expect(deadError).toBeNull()
    // Exact: its run charged it at exactly the held amount, so it has no settle row - only
    // the run's charged_at closes it, and that run is deleted with the project.
    const exactAttempt = crypto.randomUUID()
    expect((await admin.from('credit_ledger').insert(hold(userId, projectId, exactAttempt, 2, STALE))).error).toBeNull()
    expect(
      (
        await admin.from('shot_runs').insert({
          project_id: projectId, attempt_id: exactAttempt, kind: 'generate', status: 'completed', heartbeat_at: STALE, finished_at: STALE, charged_at: STALE,
        })
      ).error
    ).toBeNull()

    const response = await api.delete(`/api/projects/${projectId}`)
    expect(response.status()).toBe(200)

    const [{ data: refunds }, { data: record }] = await Promise.all([
      admin.from('credit_ledger').select('attempt_id, delta, created_at').eq('user_id', userId).eq('kind', 'refund'),
      admin.from('deleted_projects').select('deleted_at').eq('id', projectId).single(),
    ])
    expect(refunds).toHaveLength(1)
    expect(refunds![0]).toMatchObject({ attempt_id: deadAttempt, delta: 16 })
    expect(new Date(refunds![0].created_at).getTime()).toBeLessThanOrEqual(new Date(record!.deleted_at).getTime())
    expect(deadHold).not.toBeNull()

    // The exact hold's run is gone; it still reads closed, and a release refunds nothing.
    expect((await admin.from('shot_runs').select('id').eq('attempt_id', exactAttempt)).data).toEqual([])
    expect((await balanceOf(userId))?.open_hold_live_at).toBeNull()
    await releaseStaleHolds(admin, userId)
    const { data: after } = await admin.from('credit_ledger').select('id').eq('user_id', userId).eq('kind', 'refund')
    expect(after).toHaveLength(1)

    // Control: the same run-less hold on a project that was never deleted does read open.
    const control = await seedProject(userId, 'Control')
    expect((await admin.from('credit_ledger').insert(hold(userId, control.projectId, crypto.randomUUID(), 3, STALE))).error).toBeNull()
    expect((await balanceOf(userId))?.open_hold_live_at).not.toBeNull()
  })

  test('a generation that starts between the activity check and the delete leaves no open hold', async () => {
    const { userId } = await poolSession()
    const { projectId } = await seedProject(userId)
    // Closed before the delete: charged at exactly its hold, so no settle row - never refunded.
    const exactAttempt = crypto.randomUUID()
    expect((await admin.from('credit_ledger').insert(hold(userId, projectId, exactAttempt, 1, STALE))).error).toBeNull()
    expect(
      (
        await admin.from('shot_runs').insert({
          project_id: projectId, attempt_id: exactAttempt, kind: 'generate', status: 'completed', heartbeat_at: STALE, finished_at: STALE, charged_at: STALE,
        })
      ).error
    ).toBeNull()
    const before = await balanceOf(userId)
    const lateAttempt = crypto.randomUUID()

    const result = await deleteProject({
      supabase: admin,
      service: admin,
      userId,
      projectId,
      // A shot run starts after the check passed: its hold and its run land in the window.
      afterActivityCheck: async () => {
        expect((await admin.from('credit_ledger').insert(hold(userId, projectId, lateAttempt, 2))).error).toBeNull()
        expect(
          (await admin.from('shot_runs').insert({ project_id: projectId, attempt_id: lateAttempt, kind: 'generate', status: 'running', heartbeat_at: new Date().toISOString() })).error
        ).toBeNull()
      },
    })
    expect(result.ok).toBe(true)

    const { data: refunds } = await admin.from('credit_ledger').select('attempt_id, delta').eq('user_id', userId).eq('kind', 'refund')
    expect(refunds).toEqual([{ attempt_id: lateAttempt, delta: 16 }])
    expect((await balanceOf(userId))?.balance).toBe(before!.balance)
    // Nothing held: no hold of the deleted project is unsettled except the one its charged run closed.
    const { data: holds } = await admin.from('credit_ledger').select('id, attempt_id').eq('project_id', projectId).like('dedupe_key', 'hold:%')
    const { data: settles } = await admin.from('credit_ledger').select('dedupe_key').eq('project_id', projectId).like('dedupe_key', 'settle:%')
    const settled = new Set((settles ?? []).map((r) => r.dedupe_key.slice('settle:'.length)))
    expect((holds ?? []).filter((h) => !settled.has(h.id)).map((h) => h.attempt_id)).toEqual([exactAttempt])
    expect((await balanceOf(userId))?.open_hold_live_at).toBeNull()
  })

  test('the delete path is closed to clients: a direct DELETE is refused, and the route refuses another user', async ({ request }) => {
    const { projectId } = await seedProject(primary.user.id, 'Closed path')
    const own = createClient<Database>(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    expect((await own.auth.setSession(primary.session)).error).toBeNull()
    const direct = await own.from('projects').delete().eq('id', projectId).select('id')
    expect(direct.data ?? []).toEqual([])

    const other = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: SECONDARY_STORAGE_STATE })
    const crossUser = await other.delete(`/api/projects/${projectId}`)
    expect(crossUser.status()).toBe(404)
    expect(secondary.user.id).not.toBe(primary.user.id)

    expect((await admin.from('projects').select('id').eq('id', projectId).maybeSingle()).data).not.toBeNull()
    // Clean up through the route, as the owner.
    expect((await request.delete(`/api/projects/${projectId}`)).status()).toBe(200)
  })

  test('a failed sweep is retried on the next deletion; a deletion whose project is still live is never swept', async ({ request }) => {
    // An earlier deletion whose sweep failed: deleted_projects row, no projects row, files left.
    const orphanId = crypto.randomUUID()
    const orphanFile = `${primary.user.id}/${orphanId}/images/s/a.webp`
    expect((await admin.storage.from('artifacts').upload(orphanFile, Buffer.from('x'))).error).toBeNull()
    expect(
      (
        await admin.from('deleted_projects').insert({
          id: orphanId, user_id: primary.user.id, title: 'Unswept', shot_count: 0, duration_tier: null, furthest_step: 2, created_at: new Date().toISOString(),
        })
      ).error
    ).toBeNull()
    // A failed delete: deleted_projects row written, projects row still live with its files.
    const failed = await seedProject(primary.user.id, 'Failed delete')
    expect(
      (
        await admin.from('deleted_projects').insert({
          id: failed.projectId, user_id: primary.user.id, title: 'Failed delete', shot_count: 1, duration_tier: null, furthest_step: 2, created_at: failed.createdAt,
        })
      ).error
    ).toBeNull()

    const next = await seedProject(primary.user.id, 'Next delete')
    expect((await request.delete(`/api/projects/${next.projectId}`)).status()).toBe(200)

    const [{ data: orphanRow }, { data: failedRow }] = await Promise.all([
      admin.from('deleted_projects').select('storage_purged_at').eq('id', orphanId).single(),
      admin.from('deleted_projects').select('storage_purged_at').eq('id', failed.projectId).single(),
    ])
    expect(orphanRow!.storage_purged_at).not.toBeNull()
    expect(await listObjectsUnder(admin, `${primary.user.id}/${orphanId}`)).toEqual([])
    expect(failedRow!.storage_purged_at).toBeNull()
    expect((await listObjectsUnder(admin, `${primary.user.id}/${failed.projectId}`)).length).toBe(4)

    // The live project reads as live, never "Deleted".
    const metas = await readProjectMetas(admin, primary.user.id, [failed.projectId, orphanId])
    expect(metas.find((m) => m.id === failed.projectId)?.deleted).toBeFalsy()
    expect(metas.find((m) => m.id === orphanId)).toMatchObject({ title: 'Unswept', deleted: true })
    await admin.from('deleted_projects').delete().eq('id', failed.projectId)
  })

  test('cost by project names a deleted project "Deleted" and its rows still add up to the period total', async () => {
    const { userId, api } = await poolSession()
    const kept = await seedProject(userId, 'Kept project')
    const gone = await seedProject(userId, 'Gone project')
    expect((await admin.from('credit_ledger').insert([spend(userId, kept.projectId), spend(userId, gone.projectId), spend(userId, gone.projectId)])).error).toBeNull()
    expect((await api.delete(`/api/projects/${gone.projectId}`)).status()).toBe(200)

    const { data: rows } = await admin.from('credit_ledger').select('kind, step, operation, project_id, delta').eq('user_id', userId)
    const metas = await readProjectMetas(admin, userId, [kept.projectId, gone.projectId])
    const aggregation = aggregateCreditsPeriod(
      (rows ?? []).map((r) => ({ ...r, step: r.step as Step | null, operation: r.operation as Operation | null })),
      metas
    )
    const byId = new Map(aggregation.byProject.map((p) => [p.projectId, p]))
    expect(byId.get(gone.projectId)).toMatchObject({ title: 'Gone project', deleted: true, total: 20 })
    expect(byId.get(kept.projectId)).toMatchObject({ title: 'Kept project', deleted: false, total: 10 })
    expect(aggregation.byProject.reduce((sum, p) => sum + p.total, 0)).toBe(aggregation.spentThisPeriod)
  })
})
