import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { runImagePromptGeneration } from '../src/app/api/projects/[id]/image-prompts/logic'
import { successMessage, truncatedMessage, throwingGateway } from './helpers/claude-fakes'
import type { ClaudeGateway } from '../src/lib/claude'

const GOOD_IMAGE_PROMPT =
  'A warm, detailed shot with rich color and lighting that fully describes the moment for an image generation model.'

const noopRecordFixedSpend = async () => {}
const generousGetBalance = async () => 999999
const noopEnsureSignupGrant = async () => {}

/** A deterministic fake write_image_prompts gateway: returns a complete entry for
 * every key in shotKeys except any listed in opts.omitKeys, and counts calls. */
function fakeGateway(shotKeys: string[], opts?: { truncated?: boolean; omitKeys?: string[] }) {
  let calls = 0
  const included = shotKeys.filter((k) => !opts?.omitKeys?.includes(k))
  const input = {
    prompts: included.map((shot_key) => ({ shot_key, image_prompt: GOOD_IMAGE_PROMPT })),
  }
  const gateway: ClaudeGateway = {
    async createMessage() {
      calls++
      return opts?.truncated
        ? truncatedMessage(input, 'write_image_prompts')
        : successMessage(input, 'write_image_prompts')
    },
  }
  return { gateway, getCalls: () => calls }
}

async function insertProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({ user_id: userId, title: 'Untitled project', current_step: 'workbench' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function insertShots(
  projectId: string,
  shots: { shot_key: string; image_prompt?: string | null; image_prompt_stale?: boolean }[]
) {
  const rows = shots.map((s, index) => ({
    project_id: projectId,
    order_index: index,
    shot_key: s.shot_key,
    voice_over: `Voice over for ${s.shot_key}`,
    image_prompt: s.image_prompt ?? null,
    image_prompt_stale: s.image_prompt_stale ?? true,
  }))
  const { data, error } = await admin.from('shots').insert(rows).select('id, shot_key')
  expect(error).toBeNull()
  return data! as { id: string; shot_key: string }[]
}

async function readGeneration(projectId: string) {
  const { data, error } = await admin
    .from('generations')
    .select('state, payload, error')
    .eq('project_id', projectId)
    .eq('step', 'image_prompts')
    .eq('operation', 'write_image_prompts')
    .is('shot_id', null)
    .single()
  expect(error).toBeNull()
  return data!
}

async function readShots(projectId: string) {
  const { data, error } = await admin
    .from('shots')
    .select('id, shot_key, image_prompt, image_prompt_stale')
    .eq('project_id', projectId)
  expect(error).toBeNull()
  return data!
}

test.describe('image prompt generation', () => {
  test('writes image_prompt for the requested shots and clears image_prompt_stale', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id)
    const shots = await insertShots(projectId, [{ shot_key: 'b2c3d' }, { shot_key: 'f4g5h' }])
    const { gateway, getCalls } = fakeGateway(['b2c3d', 'f4g5h'])

    const result = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: shots.map((s) => s.id),
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(result.ok).toBe(true)
    expect(getCalls()).toBe(1)

    const rows = await readShots(projectId)
    for (const row of rows) {
      expect(row.image_prompt).toBe(GOOD_IMAGE_PROMPT)
      expect(row.image_prompt_stale).toBe(false)
    }

    const generation = await readGeneration(projectId)
    expect(generation.state).toBe('succeeded')
    expect(generation.payload).toBeNull()
  })

  test('partial persistence: a subset returned by Claude persists and clears stale; the rest is reported missing and untouched', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id)
    const shots = await insertShots(projectId, [
      { shot_key: 'b2c3d', image_prompt_stale: true },
      { shot_key: 'f4g5h', image_prompt_stale: true },
      { shot_key: 'j6k7m', image_prompt_stale: true },
    ])
    const { gateway } = fakeGateway(['b2c3d', 'f4g5h', 'j6k7m'], { omitKeys: ['j6k7m'] })

    const result = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: shots.map((s) => s.id),
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(result.ok).toBe(false)
    if (!result.ok && result.status === 422) {
      expect(result.missingShotKeys).toEqual(['j6k7m'])
    } else {
      throw new Error(`expected a 422, got ${JSON.stringify(result)}`)
    }

    const rows = await readShots(projectId)
    const byKey = new Map(rows.map((r) => [r.shot_key, r]))
    expect(byKey.get('b2c3d')!.image_prompt).toBe(GOOD_IMAGE_PROMPT)
    expect(byKey.get('b2c3d')!.image_prompt_stale).toBe(false)
    expect(byKey.get('f4g5h')!.image_prompt).toBe(GOOD_IMAGE_PROMPT)
    expect(byKey.get('f4g5h')!.image_prompt_stale).toBe(false)
    // Never returned by Claude - untouched, stale flag left exactly as seeded.
    expect(byKey.get('j6k7m')!.image_prompt).toBeNull()
    expect(byKey.get('j6k7m')!.image_prompt_stale).toBe(true)
  })

  test('image_prompt_stale is cleared only for shots inside the request scope - shots outside it are never touched', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id)
    const shots = await insertShots(projectId, [
      { shot_key: 'b2c3d', image_prompt_stale: true },
      { shot_key: 'outside', image_prompt_stale: true },
    ])
    const inScope = shots.find((s) => s.shot_key === 'b2c3d')!
    const { gateway } = fakeGateway(['b2c3d'])

    const result = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: [inScope.id],
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(result.ok).toBe(true)

    const rows = await readShots(projectId)
    const byKey = new Map(rows.map((r) => [r.shot_key, r]))
    expect(byKey.get('b2c3d')!.image_prompt_stale).toBe(false)
    // Out of scope: never read or written by this call at all.
    expect(byKey.get('outside')!.image_prompt).toBeNull()
    expect(byKey.get('outside')!.image_prompt_stale).toBe(true)
  })

  test('a max_tokens truncation settles failed, clears the payload, and still counts whatever persisted', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id)
    const shots = await insertShots(projectId, [{ shot_key: 'b2c3d' }])
    const { gateway } = fakeGateway(['b2c3d'], { truncated: true })

    const result = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: shots.map((s) => s.id),
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)

    const generation = await readGeneration(projectId)
    expect(generation.state).toBe('failed')
    expect(generation.payload).toBeNull()
  })

  test('a persisted payload is replayed on RECOVER without a second Claude call', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id)
    const shots = await insertShots(projectId, [
      { shot_key: 'b2c3d', image_prompt_stale: true },
      { shot_key: 'f4g5h', image_prompt_stale: true },
    ])

    const payload = {
      prompts: [
        { shot_key: 'b2c3d', image_prompt: GOOD_IMAGE_PROMPT },
        { shot_key: 'f4g5h', image_prompt: GOOD_IMAGE_PROMPT },
      ],
    }
    const { error: generationError } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: 'failed',
      payload: payload as never,
    })
    expect(generationError).toBeNull()

    const result = await runImagePromptGeneration({
      gateway: throwingGateway('RECOVER must never call the gateway'),
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: shots.map((s) => s.id),
      retry: true,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(result.ok).toBe(true)

    const rows = await readShots(projectId)
    for (const row of rows) {
      expect(row.image_prompt).toBe(GOOD_IMAGE_PROMPT)
      expect(row.image_prompt_stale).toBe(false)
    }

    const generation = await readGeneration(projectId)
    expect(generation.state).toBe('succeeded')
    expect(generation.payload).toBeNull()
  })

  test('a succeeded claim is retry-reclaimable (policy allows repeatable Regenerate calls)', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id)
    const shots = await insertShots(projectId, [{ shot_key: 'b2c3d' }])
    const { gateway } = fakeGateway(['b2c3d'])

    const first = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: shots.map((s) => s.id),
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(first.ok).toBe(true)

    // Without retry:true, a succeeded row is retry_required, never already_ready -
    // already_ready is unreachable for this operation under the new policy.
    const second = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: shots.map((s) => s.id),
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(second.ok).toBe(false)
    expect(second.status).toBe(409)
    expect(!second.ok && 'reason' in second && second.reason).toBe('retry_required')

    // With retry:true, it reclaims and succeeds again - this is what makes
    // Regenerate All / Regenerate Stale / single-row regenerate work more than once.
    const third = await runImagePromptGeneration({
      gateway,
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: shots.map((s) => s.id),
      retry: true,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(third.ok).toBe(true)
  })

  test('a fresh generating claim blocks a concurrent call as already_generating', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id)
    const shots = await insertShots(projectId, [{ shot_key: 'b2c3d' }])
    const { gateway } = fakeGateway(['b2c3d'])

    const [first, second] = await Promise.all([
      runImagePromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        shotIds: shots.map((s) => s.id),
        retry: false,
        attemptId: crypto.randomUUID(),
        recordFixedSpend: noopRecordFixedSpend,
        getBalance: generousGetBalance,
        ensureSignupGrant: noopEnsureSignupGrant,
      }),
      runImagePromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        shotIds: shots.map((s) => s.id),
        retry: false,
        attemptId: crypto.randomUUID(),
        recordFixedSpend: noopRecordFixedSpend,
        getBalance: generousGetBalance,
        ensureSignupGrant: noopEnsureSignupGrant,
      }),
    ])

    const outcomes = [first.ok, second.ok].sort()
    expect(outcomes).toEqual([false, true])
    const blocked = [first, second].find((r) => !r.ok)
    expect(blocked && !blocked.ok && blocked.status).toBe(409)
    expect(blocked && !blocked.ok && 'reason' in blocked && blocked.reason).toBe('already_generating')
  })

  test('404 when the project does not exist or is not owned by the caller', async () => {
    const user = primary.user
    const result = await runImagePromptGeneration({
      gateway: throwingGateway('must never be called'),
      supabase: admin,
      projectId: crypto.randomUUID(),
      userId: user.id,
      shotIds: [crypto.randomUUID()],
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  test('400 when a shotId does not belong to the project', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id)
    await insertShots(projectId, [{ shot_key: 'b2c3d' }])

    const result = await runImagePromptGeneration({
      gateway: throwingGateway('must never be called'),
      supabase: admin,
      projectId,
      userId: user.id,
      shotIds: [crypto.randomUUID()],
      retry: false,
      attemptId: crypto.randomUUID(),
      recordFixedSpend: noopRecordFixedSpend,
      getBalance: generousGetBalance,
      ensureSignupGrant: noopEnsureSignupGrant,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
  })
})
