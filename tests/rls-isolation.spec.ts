import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/database.types'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

// Cross-user RLS isolation, table by table, at the database layer: `secondary` holds a real
// session (its own JWT, the anon key - never service role) and tries to read, insert,
// update and delete rows that belong to `primary`. Every attempt must see nothing and
// change nothing; after each write attempt the row is re-read through the service role to
// prove it is untouched. These assert on the specific rows seeded here, never per-user
// totals, so the shared fixed users are correct.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

type Db = SupabaseClient<Database>
type Seeded = {
  projectId: string
  shotId: string
  elementId: string
  dialogueId: string
  messageId: string
  generationId: string
  usageId: string
  ledgerId: string
  exportId: string
  objectPath: string
}

let other: Db
let seeded: Seeded

const ALPH = '23456789bcdfghjkmnpqrstvwxz'
const shotKey = () => Array.from({ length: 5 }, () => ALPH[Math.floor(Math.random() * ALPH.length)]).join('')

async function seed(): Promise<Seeded> {
  const uid = primary.user.id
  const one = async <T extends { id: string }>(p: PromiseLike<{ data: T | null; error: unknown }>) => {
    const { data, error } = await p
    expect(error).toBeNull()
    return data!.id
  }
  const projectId = await one(
    admin
      .from('projects')
      .insert({ user_id: uid, title: 'RLS isolation', source_text: 'A short film.', current_step: 'storyboard', furthest_step: stepIndex('storyboard') })
      .select('id')
      .single()
  )
  const shotId = await one(
    admin
      .from('shots')
      .insert({ project_id: projectId, order_index: 0, shot_key: shotKey(), voice_over: 'Line.', visual_description: 'A harbour', duration_sec: 5 })
      .select('id')
      .single()
  )
  const elementId = await one(
    admin.from('elements').insert({ project_id: projectId, name: `Keeper ${crypto.randomUUID()}`, type: 'character' }).select('id').single()
  )
  const { error: bindError } = await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })
  expect(bindError).toBeNull()
  const dialogueId = await one(
    admin
      .from('shot_dialogue')
      .insert({ project_id: projectId, shot_id: shotId, element_id: elementId, line: 'Hello.', order_index: 0 })
      .select('id')
      .single()
  )
  const messageId = await one(admin.from('messages').insert({ project_id: projectId, role: 'user', content: 'Mine.' }).select('id').single())
  const generationId = await one(
    admin
      .from('generations')
      .insert({ project_id: projectId, step: 'storyboard', operation: 'generate_image', shot_id: shotId, element_id: null, state: 'failed' })
      .select('id')
      .single()
  )
  const usageId = await one(
    admin
      .from('usage')
      .insert({
        user_id: uid,
        project_id: projectId,
        step: 'workbench',
        operation: 'agent_turn',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        status: 'succeeded',
        estimated_cost: 0.01,
      })
      .select('id')
      .single()
  )
  const ledgerId = await one(
    admin
      .from('credit_ledger')
      .insert({ user_id: uid, kind: 'adjustment', delta: 7, dedupe_key: `rls-isolation:${crypto.randomUUID()}`, price_version: 'test' })
      .select('id')
      .single()
  )
  const exportId = await one(
    admin
      .from('exports')
      .insert({ user_id: uid, project_id: projectId, status: 'failed', settings: {}, film_hash: 'rls-isolation' })
      .select('id')
      .single()
  )
  const objectPath = `${uid}/${projectId}/rls-isolation/${crypto.randomUUID()}.txt`
  const { error: uploadError } = await admin.storage.from('artifacts').upload(objectPath, Buffer.from('mine'), { contentType: 'text/plain' })
  expect(uploadError).toBeNull()
  return { projectId, shotId, elementId, dialogueId, messageId, generationId, usageId, ledgerId, exportId, objectPath }
}

test.beforeAll(async () => {
  other = createClient<Database>(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await other.auth.setSession(secondary.session)
  expect(error).toBeNull()
  // Positive control: this client is authenticated as secondary (not anon), so an empty
  // read below is RLS hiding primary's row, not a missing session.
  const { data: who } = await other.auth.getUser()
  expect(who.user?.id).toBe(secondary.user.id)
  const { data: ownProject, error: ownError } = await admin
    .from('projects')
    .insert({ user_id: secondary.user.id, title: 'RLS isolation control' })
    .select('id')
    .single()
  expect(ownError).toBeNull()
  const ownRead = await other.from('projects').select('id').eq('id', ownProject!.id)
  expect(ownRead.data).toEqual([{ id: ownProject!.id }])
  await admin.from('projects').delete().eq('id', ownProject!.id)
  seeded = await seed()
})

test.afterAll(async () => {
  await admin.storage.from('artifacts').remove([seeded.objectPath])
  await admin.from('usage').delete().eq('id', seeded.usageId)
  await admin.from('credit_ledger').delete().eq('id', seeded.ledgerId)
  await admin.from('projects').delete().eq('id', seeded.projectId) // cascades the project's children
})

/** A refused insert: RLS rejects the row outright (42501), and nothing was written. */
function expectRefusedInsert(error: { code?: string } | null, label: string) {
  expect(error, label).not.toBeNull()
  expect(error?.code, label).toBe('42501')
}

type Table = 'projects' | 'messages' | 'shots' | 'elements' | 'generations' | 'usage' | 'shot_dialogue' | 'credit_ledger' | 'exports'

/** Reads, updates and deletes one of primary's rows by id as secondary: nothing seen, nothing changed. */
async function expectRowIsolated(table: Table, id: string, update: Record<string, unknown>) {
  const read = await other.from(table).select('id').eq('id', id)
  expect(read.error, `${table} read`).toBeNull()
  expect(read.data, `${table} read`).toEqual([])

  const before = await admin.from(table).select('*').eq('id', id).single()
  const updated = await other.from(table).update(update as never).eq('id', id).select('id')
  // No visible row to update: either no rows touched, or (no UPDATE policy at all) refused.
  if (updated.error) expect(updated.error.code, `${table} update`).toBe('42501')
  else expect(updated.data, `${table} update`).toEqual([])

  const deleted = await other.from(table).delete().eq('id', id).select('id')
  if (deleted.error) expect(deleted.error.code, `${table} delete`).toBe('42501')
  else expect(deleted.data, `${table} delete`).toEqual([])

  const after = await admin.from(table).select('*').eq('id', id).single()
  expect(after.error, `${table} still there`).toBeNull()
  expect(after.data, `${table} unchanged`).toEqual(before.data)
}

test.describe('cross-user RLS isolation: a second user can neither read nor write the first user\'s rows', () => {
  test('projects', async () => {
    await expectRowIsolated('projects', seeded.projectId, { title: 'Hijacked' })
    const { error } = await other.from('projects').insert({ user_id: primary.user.id, title: 'Planted' })
    expectRefusedInsert(error, 'projects insert')
  })

  test('messages', async () => {
    await expectRowIsolated('messages', seeded.messageId, { content: 'Hijacked' })
    const { error } = await other.from('messages').insert({ project_id: seeded.projectId, role: 'user', content: 'Planted' })
    expectRefusedInsert(error, 'messages insert')
  })

  test('shots', async () => {
    await expectRowIsolated('shots', seeded.shotId, { voice_over: 'Hijacked' })
    const { error } = await other
      .from('shots')
      .insert({ project_id: seeded.projectId, order_index: 9, shot_key: shotKey(), voice_over: 'Planted', visual_description: 'x', duration_sec: 5 })
    expectRefusedInsert(error, 'shots insert')
  })

  test('elements', async () => {
    await expectRowIsolated('elements', seeded.elementId, { name: 'Hijacked' })
    const { error } = await other.from('elements').insert({ project_id: seeded.projectId, name: `Planted ${crypto.randomUUID()}`, type: 'prop' })
    expectRefusedInsert(error, 'elements insert')
  })

  test('shot_elements', async () => {
    // Composite key, no id: addressed by (shot_id, element_id).
    const match = { shot_id: seeded.shotId, element_id: seeded.elementId }
    const read = await other.from('shot_elements').select('shot_id').match(match)
    expect(read.error).toBeNull()
    expect(read.data).toEqual([])
    const deleted = await other.from('shot_elements').delete().match(match).select('shot_id')
    expect(deleted.error).toBeNull()
    expect(deleted.data).toEqual([])
    const still = await admin.from('shot_elements').select('shot_id').match(match)
    expect(still.data).toHaveLength(1)

    // Inserting a binding into primary's shot is refused by RLS (WITH CHECK runs before the
    // primary-key check, so this is the policy's refusal, not a duplicate-key error).
    const { error } = await other.from('shot_elements').insert({ shot_id: seeded.shotId, element_id: seeded.elementId })
    expectRefusedInsert(error, 'shot_elements insert')
    const { count } = await admin.from('shot_elements').select('shot_id', { count: 'exact', head: true }).match(match)
    expect(count).toBe(1)
  })

  test('generations', async () => {
    await expectRowIsolated('generations', seeded.generationId, { state: 'succeeded' })
    const { error } = await other
      .from('generations')
      .insert({ project_id: seeded.projectId, step: 'workbench', operation: 'generate_shots', shot_id: null, element_id: null, state: 'generating' })
    expectRefusedInsert(error, 'generations insert')
  })

  test('usage', async () => {
    await expectRowIsolated('usage', seeded.usageId, { estimated_cost: 0 })
    // As primary's user_id, and as secondary's own user_id against primary's project.
    const asPrimary = await other.from('usage').insert({
      user_id: primary.user.id,
      project_id: null,
      step: 'workbench',
      operation: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      status: 'pending',
      estimated_cost: 0.01,
    })
    expectRefusedInsert(asPrimary.error, 'usage insert as primary')
    const intoPrimaryProject = await other.from('usage').insert({
      user_id: secondary.user.id,
      project_id: seeded.projectId,
      step: 'workbench',
      operation: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      status: 'pending',
      estimated_cost: 0.01,
    })
    expectRefusedInsert(intoPrimaryProject.error, 'usage insert into primary project')
  })

  test('shot_dialogue', async () => {
    await expectRowIsolated('shot_dialogue', seeded.dialogueId, { line: 'Hijacked' })
    const { error } = await other
      .from('shot_dialogue')
      .insert({ project_id: seeded.projectId, shot_id: seeded.shotId, element_id: seeded.elementId, line: 'Planted', order_index: 5 })
    expectRefusedInsert(error, 'shot_dialogue insert')
  })

  test('credit_ledger', async () => {
    await expectRowIsolated('credit_ledger', seeded.ledgerId, { delta: 9999 })
    const { error } = await other
      .from('credit_ledger')
      .insert({ user_id: primary.user.id, kind: 'adjustment', delta: 1, dedupe_key: `rls-planted:${crypto.randomUUID()}`, price_version: 'test' })
    expectRefusedInsert(error, 'credit_ledger insert')
  })

  test('exports', async () => {
    await expectRowIsolated('exports', seeded.exportId, { status: 'queued' })
    const { error } = await other
      .from('exports')
      .insert({ user_id: primary.user.id, project_id: seeded.projectId, settings: {}, film_hash: 'planted' })
    expectRefusedInsert(error, 'exports insert')
  })

  test('storage.objects (artifacts bucket)', async () => {
    const bucket = other.storage.from('artifacts')
    const download = await bucket.download(seeded.objectPath)
    expect(download.error).not.toBeNull()
    expect(download.data).toBeNull()

    const folder = seeded.objectPath.slice(0, seeded.objectPath.lastIndexOf('/'))
    const listed = await bucket.list(folder)
    expect(listed.data ?? []).toEqual([])

    const signed = await bucket.createSignedUrl(seeded.objectPath, 60)
    expect(signed.data).toBeNull()

    const planted = `${primary.user.id}/${seeded.projectId}/rls-isolation/planted-${crypto.randomUUID()}.txt`
    const upload = await bucket.upload(planted, Buffer.from('planted'), { contentType: 'text/plain' })
    expect(upload.error).not.toBeNull()
    const overwrite = await bucket.upload(seeded.objectPath, Buffer.from('hijacked'), { contentType: 'text/plain', upsert: true })
    expect(overwrite.error).not.toBeNull()

    const removed = await bucket.remove([seeded.objectPath])
    expect(removed.data ?? []).toEqual([])

    // Through the service role: the original is intact and nothing was planted.
    const original = await admin.storage.from('artifacts').download(seeded.objectPath)
    expect(original.error).toBeNull()
    expect(await original.data!.text()).toBe('mine')
    const plantedCheck = await admin.storage.from('artifacts').download(planted)
    expect(plantedCheck.data).toBeNull()
  })
})
