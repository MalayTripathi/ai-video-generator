import { test, expect } from '@playwright/test'
import { framePrice } from './helpers/prices'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { CREDIT_PRICE_VERSION, SIGNUP_GRANT_CREDITS } from '../src/lib/config/credits'
import {
  CLAIM_STALE_MARGIN_MS,
  CONTINUATION_CHAIN_LIMIT,
  IMAGES_ROUTE_MAX_DURATION_S,
  IMAGE_HANDOFF_TIMEOUT_MS,
  IMAGE_QUEUE_STALE_AFTER_MS,
  IMAGE_SDK_TIMEOUT_MS,
  IMAGE_STALE_AFTER_MS,
  RUN_TIME_BUDGET_MS,
  STORYBOARD_IMAGE_SIZES,
  STORYBOARD_SIGNED_URL_EXPIRES_S,
  STORYBOARD_THUMB_WIDTH,
} from '../src/lib/config/storyboard'
import { claimGeneration, markGenerationStarted, releaseQueuedGenerations } from '../src/lib/generations/claim'
import { deriveImageState } from '../src/lib/storyboard/image-state'
import { successImageGateway, throwingImageGateway } from './helpers/openai-fakes'
import {
  createContinueRun,
  runImageWorker,
  runImagesContinuation,
  runImagesRequest,
  storyboardImagePath,
  storyboardThumbPath,
  type ContinuationPayload,
  type ImageWorkerDeps,
} from '../src/app/api/projects/[id]/images/logic'
import { loadImageStatuses } from '../src/app/api/projects/[id]/images/status/logic'
import type { recordFixedSpend } from '../src/lib/credits/ledger'
import type { getBalance as getBalanceType } from '../src/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '../src/lib/credits/signup-grant'

// Every provider call below goes to a fake from tests/helpers/openai-fakes.ts. Nothing
// here can reach OpenAI.

// A 9:16, low-quality frame with no references - seedProject's default.
const PRICE = framePrice()
const PROMPT = 'A lone lighthouse on a basalt cliff at dusk, waves breaking below, warm window light.'

// --- ledger writer: service-role + 'server-only', so it runs in a child process (same
// dispatcher as elements-reference-generation.spec.ts) --------------------------------
const LEDGER_URL = 'file://' + path.resolve(__dirname, '../src/lib/credits/ledger.ts')
const ALIAS_LOADER_URL = 'file://' + path.resolve(__dirname, 'helpers/ts-alias-loader.mjs')

function runLedgerCall(fn: string, arg: unknown): Promise<{ ok: boolean; message?: string }> {
  const script = `
    const { register } = require('node:module')
    register(${JSON.stringify(ALIAS_LOADER_URL)})
    import(${JSON.stringify(LEDGER_URL)}).then(async (m) => {
      try {
        await m[${JSON.stringify(fn)}](${JSON.stringify(arg)})
        process.stdout.write(JSON.stringify({ ok: true }))
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }))
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
      if (code !== 0) return reject(new Error(`ledger child exited ${code}: ${stderr}`))
      resolve(JSON.parse(stdout.trim()))
    })
  })
}

const realRecordFixedSpend: typeof recordFixedSpend = async (params) => {
  const result = await runLedgerCall('recordFixedSpend', params)
  if (!result.ok) throw new Error(`recordFixedSpend failed: ${result.message}`)
}

const realGetBalance: typeof getBalanceType = async (userId) => {
  const { data, error } = await admin.from('credit_ledger').select('delta').eq('user_id', userId)
  if (error) throw new Error(error.message)
  return data.reduce((sum, row) => sum + row.delta, 0)
}

const realEnsureSignupGrant: typeof ensureSignupGrantType = async (userId) => {
  const { data: existing } = await admin
    .from('credit_ledger')
    .select('id')
    .eq('user_id', userId)
    .eq('dedupe_key', `signup_grant:${userId}`)
    .maybeSingle()
  if (existing) return
  await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'signup_grant',
    delta: SIGNUP_GRANT_CREDITS,
    dedupe_key: `signup_grant:${userId}`,
    price_version: 'test',
  })
}

async function setBalance(userId: string, remaining: number) {
  await realEnsureSignupGrant(userId)
  const balance = await realGetBalance(userId)
  const { error } = await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'spend',
    delta: -(balance - remaining),
    step: 'workbench',
    operation: 'generate_shots',
    attempt_id: crypto.randomUUID(),
    dedupe_key: `test-drain:${crypto.randomUUID()}`,
    price_version: 'test',
    pricing_mode: 'fixed',
  })
  expect(error).toBeNull()
}

// --- seeding ------------------------------------------------------------------------

async function seedProject(userId: string, aspectRatio: '9:16' | '16:9' | '1:1' = '9:16') {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Storyboard images test',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
      aspect_ratio: aspectRatio,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

const SHOT_KEYS = ['bcdfg', 'hjkmn', 'pqrst', 'vwxzb', 'cdfgh', 'jkmnp']

async function seedShots(projectId: string, count: number, prompt: string | null = PROMPT) {
  const rows = Array.from({ length: count }, (_, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: SHOT_KEYS[i],
    voice_over: `Voice over ${i + 1}.`,
    image_prompt: prompt,
    image_stale: true,
  }))
  const { data, error } = await admin.from('shots').insert(rows).select('id, order_index').order('order_index')
  expect(error).toBeNull()
  return data!.map((r) => r.id as string)
}

async function bindReference(userId: string, projectId: string, shotId: string) {
  const { data: element, error } = await admin
    .from('elements')
    .insert({ project_id: projectId, name: `Ref ${crypto.randomUUID()}`, type: 'character' })
    .select('id')
    .single()
  expect(error).toBeNull()
  const refPath = `${userId}/${projectId}/elements/${element!.id}/${crypto.randomUUID()}.webp`
  const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .webp()
    .toBuffer()
  const { error: uploadError } = await admin.storage
    .from('artifacts')
    .upload(refPath, webp, { contentType: 'image/webp', upsert: false })
  expect(uploadError).toBeNull()
  await admin.from('elements').update({ reference_image_path: refPath, status: 'ready' }).eq('id', element!.id)
  const { error: bindError } = await admin.from('shot_elements').insert({ shot_id: shotId, element_id: element!.id })
  expect(bindError).toBeNull()
}

// --- reads --------------------------------------------------------------------------

async function claims(projectId: string) {
  const { data, error } = await admin
    .from('generations')
    .select('id, shot_id, state, payload, queued_at, started_at, error')
    .eq('project_id', projectId)
    .eq('step', 'storyboard')
    .eq('operation', 'generate_image')
  expect(error).toBeNull()
  return data!
}

async function ledgerRows(projectId: string) {
  const { data, error } = await admin
    .from('credit_ledger')
    .select('delta, step, operation, attempt_id, dedupe_key, shot_key, price_version')
    .eq('project_id', projectId)
  expect(error).toBeNull()
  return data!
}

async function usageRows(projectId: string) {
  const { data, error } = await admin
    .from('usage')
    .select('status, shot_id, generation_id, raw_usage, estimated_cost')
    .eq('project_id', projectId)
  expect(error).toBeNull()
  return data!
}

async function shotRow(shotId: string) {
  const { data, error } = await admin.from('shots').select('image_path, image_stale').eq('id', shotId).single()
  expect(error).toBeNull()
  return data!
}

// --- runners --------------------------------------------------------------------------

function request(userId: string, projectId: string, shotIds: string[]) {
  return runImagesRequest({
    supabase: admin,
    projectId,
    userId,
    shotIds,
    getBalance: realGetBalance,
    ensureSignupGrant: realEnsureSignupGrant,
  })
}

function deps(gateway: ImageWorkerDeps['gateway'], overrides: Partial<ImageWorkerDeps> = {}): ImageWorkerDeps {
  return {
    supabase: admin,
    gateway,
    mintAttemptId: () => crypto.randomUUID(),
    recordFixedSpend: realRecordFixedSpend,
    continueRun: async () => false,
    ...overrides,
  }
}

/** Claims and runs one batch to completion in-process - what the route does via after(). */
async function generate(userId: string, projectId: string, shotIds: string[], gateway: ImageWorkerDeps['gateway']) {
  const req = await request(userId, projectId, shotIds)
  expect(req.ok).toBe(true)
  if (!req.ok) throw new Error('request failed')
  const run = await runImageWorker(deps(gateway), {
    userId,
    projectId,
    generationIds: req.data.generationIds,
    chainDepth: 0,
  })
  return { req: req.data, run }
}

// Releases any claim a test left queued, so primary's in-flight commitment (which other
// specs' gates count) never carries it.
async function releaseClaims(projectId: string) {
  await admin
    .from('generations')
    .update({ state: 'failed', queued_at: null })
    .eq('project_id', projectId)
    .eq('state', 'generating')
}

// ---------------------------------------------------------------------------------------

test.describe('storyboard images - config', () => {
  test('sizes are native to each aspect ratio and satisfy the provider size rules', () => {
    for (const [ratio, size] of Object.entries(STORYBOARD_IMAGE_SIZES)) {
      const [w, h] = size.split('x').map(Number)
      const [rw, rh] = ratio.split(':').map(Number)
      expect(w * rh).toBe(h * rw)
      expect(w % 16).toBe(0)
      expect(h % 16).toBe(0)
      expect(Math.max(w, h)).toBeLessThanOrEqual(3840)
      expect(w * h).toBeGreaterThanOrEqual(655_360)
      expect(w * h).toBeLessThanOrEqual(8_294_400)
    }
  })

  test('budget + one shot fits the route; both windows sit just past what they protect', () => {
    const ceilingMs = IMAGES_ROUTE_MAX_DURATION_S * 1000
    expect(IMAGES_ROUTE_MAX_DURATION_S).toBeLessThanOrEqual(300)
    // A shot started at the budget's last moment: the SDK call plus encode, upload and writes.
    expect(RUN_TIME_BUDGET_MS + IMAGE_SDK_TIMEOUT_MS + 30_000).toBeLessThanOrEqual(ceilingMs)
    // A started shot can live until its run is killed - never read as dead before that.
    expect(IMAGE_STALE_AFTER_MS).toBeGreaterThan(ceilingMs)
    expect(IMAGE_STALE_AFTER_MS).toBeLessThanOrEqual(ceilingMs + CLAIM_STALE_MARGIN_MS)
    // A queued shot waits at most one budget + hand-off per run in the chain.
    const queuedCeilingMs = (CONTINUATION_CHAIN_LIMIT + 1) * (RUN_TIME_BUDGET_MS + IMAGE_HANDOFF_TIMEOUT_MS)
    expect(IMAGE_QUEUE_STALE_AFTER_MS).toBeGreaterThan(queuedCeilingMs)
    expect(IMAGE_QUEUE_STALE_AFTER_MS).toBeLessThanOrEqual(queuedCeilingMs + CLAIM_STALE_MARGIN_MS)
    expect(RUN_TIME_BUDGET_MS).toBe(150_000)
    expect(CONTINUATION_CHAIN_LIMIT).toBe(16)
    const route = readFileSync(path.resolve(__dirname, '../src/app/api/projects/[id]/images/route.ts'), 'utf8')
    expect(route).toContain(`export const maxDuration = ${IMAGES_ROUTE_MAX_DURATION_S}`)
  })
})

test.describe('storyboard images - request validation and gate', () => {
  test('a shot with no image prompt is refused with 422 and nothing is written', async () => {
    const projectId = await seedProject(primary.user.id)
    const [withPrompt] = await seedShots(projectId, 1)
    const { data: blank } = await admin
      .from('shots')
      .insert({ project_id: projectId, order_index: 1, shot_key: 'zzzzz', voice_over: 'x', image_prompt: '  ' })
      .select('id')
      .single()

    const result = await request(primary.user.id, projectId, [withPrompt, blank!.id])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      if ('shotIds' in result) expect(result.shotIds).toEqual([blank!.id])
    }
    expect(await claims(projectId)).toHaveLength(0)
  })

  test('402 when nothing is affordable writes no generations, usage or ledger row', async () => {
    const { user } = await createTestSession()
    try {
      await setBalance(user.id, PRICE - 1)
      const projectId = await seedProject(user.id)
      const shotIds = await seedShots(projectId, 2)

      const result = await request(user.id, projectId, shotIds)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(402)

      expect(await claims(projectId)).toHaveLength(0)
      expect(await usageRows(projectId)).toHaveLength(0)
      expect(await ledgerRows(projectId)).toHaveLength(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a partial afford claims in order and leaves the rest not generated; in-flight claims block a second batch', async () => {
    const { user } = await createTestSession()
    try {
      await setBalance(user.id, PRICE * 2)
      const projectA = await seedProject(user.id)
      const shotsA = await seedShots(projectA, 3)

      const first = await request(user.id, projectA, shotsA)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      expect(first.data.claimed).toEqual([shotsA[0], shotsA[1]])
      expect(first.data.notGenerated).toEqual([shotsA[2]])
      const rows = await claims(projectA)
      expect(rows.map((r) => r.shot_id).sort()).toEqual([shotsA[0], shotsA[1]].sort())
      expect(rows.every((r) => r.state === 'generating' && r.queued_at !== null)).toBe(true)

      // The two queued claims already commit the whole balance, even though nothing has
      // been charged yet - a batch in another project can't spend it again.
      const projectB = await seedProject(user.id)
      const shotsB = await seedShots(projectB, 1)
      const second = await request(user.id, projectB, shotsB)
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.status).toBe(402)
      expect(await claims(projectB)).toHaveLength(0)

      await releaseClaims(projectA)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('claims are per shot: one shot in flight never blocks another', async () => {
    const projectId = await seedProject(primary.user.id)
    const [a, b] = await seedShots(projectId, 2)

    const first = await request(primary.user.id, projectId, [a])
    expect(first.ok && first.data.claimed).toEqual([a])

    const second = await request(primary.user.id, projectId, [b, a])
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.claimed).toEqual([b])
      expect(second.data.inFlight).toEqual([a])
    }
    await releaseClaims(projectId)
  })
})

test.describe('storyboard images - worker', () => {
  // Local runs always carry IMAGE_QUALITY_DEV_CAP (required off production - env.ts class C).
  // 'high' lowers nothing, so each call here carries the project's own quality unless a
  // test sets its own cap.
  let savedCap: string | undefined
  test.beforeEach(() => {
    savedCap = process.env.IMAGE_QUALITY_DEV_CAP
    process.env.IMAGE_QUALITY_DEV_CAP = 'high'
  })
  test.afterEach(() => {
    if (savedCap === undefined) delete process.env.IMAGE_QUALITY_DEV_CAP
    else process.env.IMAGE_QUALITY_DEV_CAP = savedCap
  })

  test('success stores a native-size WebP at the attempt path, clears image_stale and charges once', { tag: '@smoke' }, async () => {
    const projectId = await seedProject(primary.user.id, '9:16')
    const [shotId] = await seedShots(projectId, 1)
    const gateway = successImageGateway()

    const { run } = await generate(primary.user.id, projectId, [shotId], gateway)
    expect(Object.values(run.outcomes)).toEqual(['succeeded'])
    expect(gateway.getStoryboardCalls()).toEqual([
      expect.objectContaining({ size: '1008x1792', referenceCount: 0, prompt: PROMPT }),
    ])

    const ledger = await ledgerRows(projectId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ delta: -PRICE, step: 'storyboard', operation: 'generate_image', shot_key: 'bcdfg' })
    expect(ledger[0].dedupe_key).toBe(`generate_image:${ledger[0].attempt_id}`)

    const shot = await shotRow(shotId)
    expect(shot.image_stale).toBe(false)
    expect(shot.image_path).toBe(storyboardImagePath(primary.user.id, projectId, shotId, ledger[0].attempt_id!))

    const { data: blob } = await admin.storage.from('artifacts').download(shot.image_path!)
    const meta = await sharp(Buffer.from(await blob!.arrayBuffer())).metadata()
    expect(meta.format).toBe('webp')
    expect(`${meta.width}x${meta.height}`).toBe('1008x1792')

    const [claim] = await claims(projectId)
    expect(claim).toMatchObject({ state: 'succeeded', payload: null, queued_at: null })
    const [usage] = await usageRows(projectId)
    expect(usage).toMatchObject({ status: 'succeeded', shot_id: shotId, generation_id: claim.id })
  })

  test('each aspect ratio is stored at exactly its configured size', async () => {
    for (const ratio of ['16:9', '1:1'] as const) {
      const projectId = await seedProject(primary.user.id, ratio)
      const [shotId] = await seedShots(projectId, 1)
      await generate(primary.user.id, projectId, [shotId], successImageGateway())
      const { image_path } = await shotRow(shotId)
      const { data: blob } = await admin.storage.from('artifacts').download(image_path!)
      const meta = await sharp(Buffer.from(await blob!.arrayBuffer())).metadata()
      expect(`${meta.width}x${meta.height}`).toBe(STORYBOARD_IMAGE_SIZES[ratio])
    }
  })

  test('a failed image writes no ledger row and leaves the shot without an image', async () => {
    const projectId = await seedProject(primary.user.id)
    const [shotId] = await seedShots(projectId, 1)

    const { run } = await generate(primary.user.id, projectId, [shotId], throwingImageGateway())
    expect(Object.values(run.outcomes)).toEqual(['failed'])
    expect(await ledgerRows(projectId)).toHaveLength(0)
    expect((await shotRow(shotId)).image_path).toBeNull()
    const [claim] = await claims(projectId)
    expect(claim.state).toBe('failed')
    const [usage] = await usageRows(projectId)
    expect(usage.status).toBe('failed')
  })

  test('bound reference images go to the provider as inputs; none means text only', async () => {
    const projectId = await seedProject(primary.user.id)
    const [withRef, withoutRef] = await seedShots(projectId, 2)
    await bindReference(primary.user.id, projectId, withRef)
    const gateway = successImageGateway(undefined, undefined, (call) => ({
      input_tokens: 80 + call.referenceCount * 300,
      image_input_tokens: call.referenceCount * 300,
      output_tokens: 1200,
    }))

    await generate(primary.user.id, projectId, [withRef, withoutRef], gateway)
    const calls = gateway.getStoryboardCalls()
    expect(calls.map((c) => c.referenceCount).sort()).toEqual([0, 1])

    const usage = await usageRows(projectId)
    const withRefUsage = usage.find((u) => u.shot_id === withRef)!
    expect((withRefUsage.raw_usage as { breakdown: { image_input_tokens: number } }).breakdown.image_input_tokens).toBe(300)
  })

  test('each frame is charged on the references actually sent', async () => {
    const projectId = await seedProject(primary.user.id)
    const [withRef, withoutRef, lostRef] = await seedShots(projectId, 3)
    await bindReference(primary.user.id, projectId, withRef)
    await bindReference(primary.user.id, projectId, lostRef)
    // lostRef's object is gone: it is left out of the call, so it is not charged for.
    const { data: lost } = await admin
      .from('shot_elements')
      .select('elements(reference_image_path)')
      .eq('shot_id', lostRef)
      .single()
    const lostPath = (lost!.elements as unknown as { reference_image_path: string }).reference_image_path
    await admin.storage.from('artifacts').remove([lostPath])

    await generate(primary.user.id, projectId, [withRef, withoutRef, lostRef], successImageGateway())

    const shotKeyOf = new Map([
      [withRef, 'bcdfg'],
      [withoutRef, 'hjkmn'],
      [lostRef, 'pqrst'],
    ])
    const deltaByKey = new Map((await ledgerRows(projectId)).map((r) => [r.shot_key, r.delta]))
    expect(deltaByKey.get(shotKeyOf.get(withRef)!)).toBe(-framePrice({ referenceCount: 1 }))
    expect(deltaByKey.get(shotKeyOf.get(withoutRef)!)).toBe(-framePrice())
    expect(deltaByKey.get(shotKeyOf.get(lostRef)!)).toBe(-framePrice())
    expect(framePrice({ referenceCount: 1 })).toBeGreaterThan(framePrice())
  })

  test("the call carries the project's image quality, and the charge is priced on it", async () => {
    const projectId = await seedProject(primary.user.id, '16:9')
    await admin.from('projects').update({ image_quality: 'high' }).eq('id', projectId)
    const [shotId] = await seedShots(projectId, 1)
    const gateway = successImageGateway()

    await generate(primary.user.id, projectId, [shotId], gateway)
    expect(gateway.getStoryboardCalls()).toEqual([
      expect.objectContaining({ model: 'gpt-image-2.5-flare', quality: 'high', size: '1792x1008' }),
    ])
    const [row] = await ledgerRows(projectId)
    expect(row.delta).toBe(-framePrice({ aspectRatio: '16:9', imageQuality: 'high' }))
    expect(row.price_version).toBe(CREDIT_PRICE_VERSION)
  })

  test("the call carries the project's image model - GPT Image 2 - with references, and the charge is priced on it", async () => {
    const projectId = await seedProject(primary.user.id)
    await admin.from('projects').update({ image_model: 'gpt-image-2', image_quality: 'medium' }).eq('id', projectId)
    const [shotId] = await seedShots(projectId, 1)
    await bindReference(primary.user.id, projectId, shotId)
    const gateway = successImageGateway()

    await generate(primary.user.id, projectId, [shotId], gateway)
    expect(gateway.getStoryboardCalls()).toEqual([
      expect.objectContaining({ model: 'gpt-image-2', quality: 'medium', size: '1008x1792' }),
    ])
    const [row] = await ledgerRows(projectId)
    expect(row.delta).toBe(-framePrice({ imageModel: 'gpt-image-2', imageQuality: 'medium', referenceCount: 1 }))
    expect(framePrice({ imageModel: 'gpt-image-2', imageQuality: 'medium', referenceCount: 1 })).toBeGreaterThan(
      framePrice({ imageQuality: 'medium', referenceCount: 1 })
    )
  })

  test('IMAGE_QUALITY_DEV_CAP lowers the quality sent outside production, and the price follows it', async () => {
    const projectId = await seedProject(primary.user.id)
    await admin.from('projects').update({ image_quality: 'high' }).eq('id', projectId)
    const [shotId] = await seedShots(projectId, 1)
    const gateway = successImageGateway()

    const previous = process.env.IMAGE_QUALITY_DEV_CAP
    process.env.IMAGE_QUALITY_DEV_CAP = 'low'
    try {
      await generate(primary.user.id, projectId, [shotId], gateway)
    } finally {
      if (previous === undefined) delete process.env.IMAGE_QUALITY_DEV_CAP
      else process.env.IMAGE_QUALITY_DEV_CAP = previous
    }
    expect(gateway.getStoryboardCalls()).toEqual([expect.objectContaining({ quality: 'low' })])
    const [row] = await ledgerRows(projectId)
    expect(row.delta).toBe(-framePrice({ imageQuality: 'low' }))
    expect(framePrice({ imageQuality: 'low' })).toBeLessThan(framePrice({ imageQuality: 'high' }))
  })

  test('the status loader prices each shot on its own references', async () => {
    const projectId = await seedProject(primary.user.id, '1:1')
    const [withRef, withoutRef] = await seedShots(projectId, 2)
    await bindReference(primary.user.id, projectId, withRef)
    const result = await loadImageStatuses({ supabase: admin, projectId, userId: primary.user.id, getBalance: realGetBalance })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byId = new Map(result.data.shots.map((sh) => [sh.shotId, sh.imageCredits]))
    expect(byId.get(withRef)).toBe(framePrice({ aspectRatio: '1:1', referenceCount: 1 }))
    expect(byId.get(withoutRef)).toBe(framePrice({ aspectRatio: '1:1' }))
  })

  test('regenerating keeps every earlier image: each attempt writes a new object', async () => {
    const projectId = await seedProject(primary.user.id)
    const [shotId] = await seedShots(projectId, 1)

    await generate(primary.user.id, projectId, [shotId], successImageGateway())
    const firstPath = (await shotRow(shotId)).image_path
    await generate(primary.user.id, projectId, [shotId], successImageGateway())
    const secondPath = (await shotRow(shotId)).image_path
    expect(secondPath).not.toBe(firstPath)

    const { data: objects } = await admin.storage
      .from('artifacts')
      .list(`${primary.user.id}/${projectId}/images/${shotId}`)
    // Each attempt is its image plus its lane thumbnail.
    expect((objects ?? []).map((o) => o.name).sort()).toEqual(
      [firstPath!, secondPath!].flatMap((p) => [path.basename(p), path.basename(storyboardThumbPath(p))]).sort()
    )
    expect(await ledgerRows(projectId)).toHaveLength(2)
  })

  test('RECOVER relinks a persisted image with no provider call and never charges it twice', async () => {
    // The call that was paid for, as PERSIST stores it beside the path.
    const RECOVERED_PRICE = { model: 'gpt-image-2.5-flare', quality: 'low', size: '1008x1792', referenceCount: 1 } as const
    const projectId = await seedProject(primary.user.id)
    const [shotId] = await seedShots(projectId, 1)

    // A run that died after PERSIST and after its ledger write: object stored, payload
    // saved, charge recorded, shot never linked, claim still queued for a resume.
    const attemptId = crypto.randomUUID()
    const storedPath = storyboardImagePath(primary.user.id, projectId, shotId, attemptId)
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .webp()
      .toBuffer()
    await admin.storage.from('artifacts').upload(storedPath, webp, { contentType: 'image/webp', upsert: false })
    const now = new Date().toISOString()
    const { data: gen } = await admin
      .from('generations')
      .insert({
        project_id: projectId,
        step: 'storyboard',
        operation: 'generate_image',
        shot_id: shotId,
        element_id: null,
        state: 'generating',
        payload: { path: storedPath, attemptId, price: RECOVERED_PRICE },
        started_at: now,
        queued_at: now,
        updated_at: now,
      })
      .select('id')
      .single()
    await realRecordFixedSpend({
      userId: primary.user.id,
      step: 'storyboard',
      operation: 'generate_image',
      quantity: 1,
      attemptId,
      projectId,
      messageId: null,
      shotKey: 'bcdfg',
      image: RECOVERED_PRICE,
    })

    const gateway = successImageGateway()
    const run = await runImageWorker(deps(gateway), {
      userId: primary.user.id,
      projectId,
      generationIds: [gen!.id],
      chainDepth: 1,
    })
    expect(run.outcomes[gen!.id]).toBe('succeeded')
    expect(gateway.getCallCount()).toBe(0)
    expect((await shotRow(shotId)).image_path).toBe(storedPath)
    const ledger = await ledgerRows(projectId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].attempt_id).toBe(attemptId)
  })
})

test.describe('storyboard images - continuation', () => {
  test('a run out of budget hands its claims on, and the continuation completes the batch', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotIds = await seedShots(projectId, 3)
    const gateway = successImageGateway()
    const handoffs: ContinuationPayload[] = []

    const req = await request(primary.user.id, projectId, shotIds)
    if (!req.ok) throw new Error('request failed')

    // First run: a zero budget reaches nothing, so everything is handed on - exactly the
    // route's continuation call, done in-process.
    const continueRun = async (payload: ContinuationPayload) => {
      handoffs.push(payload)
      const resumed = await runImagesContinuation({ supabase: admin, payload })
      if (!resumed.ok) return false
      await runImageWorker(deps(gateway), { ...payload, generationIds: resumed.generationIds })
      return true
    }
    const first = await runImageWorker(deps(gateway, { runTimeBudgetMs: 0, continueRun }), {
      userId: primary.user.id,
      projectId,
      generationIds: req.data.generationIds,
      chainDepth: 0,
    })

    expect(first.continued).toEqual(req.data.generationIds)
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0].chainDepth).toBe(1)
    expect(gateway.getStoryboardCalls()).toHaveLength(3)
    expect((await claims(projectId)).every((c) => c.state === 'succeeded')).toBe(true)
    expect(await ledgerRows(projectId)).toHaveLength(3)
  })

  test('a continuation never resumes a claim that is no longer queued, so it is never charged twice', async () => {
    const projectId = await seedProject(primary.user.id)
    const [done, pending] = await seedShots(projectId, 2)
    const req = await request(primary.user.id, projectId, [done, pending])
    if (!req.ok) throw new Error('request failed')
    const [doneGen, pendingGen] = req.data.generationIds

    await runImageWorker(deps(successImageGateway()), {
      userId: primary.user.id,
      projectId,
      generationIds: [doneGen],
      chainDepth: 0,
    })

    const resumed = await runImagesContinuation({
      supabase: admin,
      payload: { userId: primary.user.id, projectId, generationIds: [doneGen, pendingGen], chainDepth: 1 },
    })
    expect(resumed.ok && resumed.generationIds).toEqual([pendingGen])

    // Even handed a started/settled id directly, the worker skips it.
    const gateway = successImageGateway()
    const rerun = await runImageWorker(deps(gateway), {
      userId: primary.user.id,
      projectId,
      generationIds: [doneGen],
      chainDepth: 1,
    })
    expect(rerun.outcomes[doneGen]).toBe('skipped')
    expect(gateway.getCallCount()).toBe(0)
    expect(await ledgerRows(projectId)).toHaveLength(1)
    await releaseClaims(projectId)
  })

  test('a continuation for another user is refused', async () => {
    const projectId = await seedProject(primary.user.id)
    const resumed = await runImagesContinuation({
      supabase: admin,
      payload: { userId: crypto.randomUUID(), projectId, generationIds: [crypto.randomUUID()], chainDepth: 1 },
    })
    expect(resumed.ok).toBe(false)
  })

  test('at the chain limit the unreached shots settle failed, are never charged, and stay retryable', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotIds = await seedShots(projectId, 2)
    const req = await request(primary.user.id, projectId, shotIds)
    if (!req.ok) throw new Error('request failed')
    let handedOn = false

    // The production chain limit - no override.
    const run = await runImageWorker(
      deps(successImageGateway(), {
        runTimeBudgetMs: 0,
        continueRun: async () => {
          handedOn = true
          return true
        },
      }),
      { userId: primary.user.id, projectId, generationIds: req.data.generationIds, chainDepth: CONTINUATION_CHAIN_LIMIT }
    )

    expect(handedOn).toBe(false)
    expect(run.abandoned.sort()).toEqual([...req.data.generationIds].sort())
    expect((await claims(projectId)).every((c) => c.state === 'failed')).toBe(true)
    expect(await usageRows(projectId)).toHaveLength(0)
    expect(await ledgerRows(projectId)).toHaveLength(0)

    // Retry claims them again at once.
    const again = await request(primary.user.id, projectId, shotIds)
    expect(again.ok && again.data.claimed.length).toBe(2)
    await releaseClaims(projectId)
  })

  test('the hand-off fires at the budget while a shot is still in flight, which finishes in-run', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotIds = await seedShots(projectId, 3)
    const req = await request(primary.user.id, projectId, shotIds)
    if (!req.ok) throw new Error('request failed')

    // The provider call holds until the hand-off has fired (5s fallback so a regression
    // fails instead of hanging).
    const inner = successImageGateway()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
      setTimeout(resolve, 5000)
    })
    let pendingCalls = 0
    const gateway: ImageWorkerDeps['gateway'] = {
      ...inner,
      async generateStoryboardImage(params) {
        pendingCalls++
        await held
        pendingCalls--
        return inner.generateStoryboardImage(params)
      },
    }
    const handoffs: { payload: ContinuationPayload; inFlight: number }[] = []
    const run = await runImageWorker(
      deps(gateway, {
        concurrency: 1,
        runTimeBudgetMs: 1500,
        continueRun: async (payload) => {
          handoffs.push({ payload, inFlight: pendingCalls })
          release()
          return true
        },
      }),
      { userId: primary.user.id, projectId, generationIds: req.data.generationIds, chainDepth: 0 }
    )

    const [firstGen, ...rest] = req.data.generationIds
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0].inFlight).toBe(1)
    expect(handoffs[0].payload).toMatchObject({ generationIds: rest, chainDepth: 1 })
    expect(run.continued).toEqual(rest)
    expect(run.outcomes[firstGen]).toBe('succeeded')
    expect(await ledgerRows(projectId)).toHaveLength(1)
    await releaseClaims(projectId)
  })

  test('a missing hand-off secret fails loudly and releases the unreached shots failed and retryable', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotIds = await seedShots(projectId, 2)
    const req = await request(primary.user.id, projectId, shotIds)
    if (!req.ok) throw new Error('request failed')

    let fetched = false
    const continueRun = createContinueRun({
      origin: 'http://127.0.0.1:1',
      secret: undefined,
      fetchImpl: async () => {
        fetched = true
        return new Response(null, { status: 202 })
      },
    })
    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    }
    let run
    try {
      run = await runImageWorker(deps(successImageGateway(), { runTimeBudgetMs: 0, continueRun }), {
        userId: primary.user.id,
        projectId,
        generationIds: req.data.generationIds,
        chainDepth: 0,
      })
    } finally {
      console.error = originalError
    }

    expect(fetched).toBe(false)
    expect(logged.some((line) => line.includes('INTERNAL_CONTINUATION_SECRET is not set'))).toBe(true)
    expect(run.continued).toEqual([])
    expect(run.abandoned.sort()).toEqual([...req.data.generationIds].sort())
    const rows = await claims(projectId)
    expect(rows.every((c) => c.state === 'failed' && c.queued_at === null)).toBe(true)
    expect(await ledgerRows(projectId)).toHaveLength(0)

    const again = await request(primary.user.id, projectId, shotIds)
    expect(again.ok && again.data.claimed.length).toBe(2)
    await releaseClaims(projectId)
  })

  test('a hand-off answered with anything but 202 counts as refused', async () => {
    const continueRun = createContinueRun({
      origin: 'http://127.0.0.1:1',
      secret: 'test-secret',
      fetchImpl: async () => new Response(null, { status: 500 }),
    })
    const originalError = console.error
    console.error = () => {}
    try {
      expect(
        await continueRun({ userId: crypto.randomUUID(), projectId: crypto.randomUUID(), generationIds: ['x'], chainDepth: 1 })
      ).toBe(false)
    } finally {
      console.error = originalError
    }
  })

  test('releasing queued claims never touches one another run has already started', async () => {
    const projectId = await seedProject(primary.user.id)
    const shotIds = await seedShots(projectId, 2)
    const req = await request(primary.user.id, projectId, shotIds)
    if (!req.ok) throw new Error('request failed')
    const [startedGen, queuedGen] = req.data.generationIds
    const startedRow = (await claims(projectId)).find((c) => c.id === startedGen)!
    const start = await markGenerationStarted(admin, startedGen, startedRow.queued_at!)
    expect(start.started).toBe(true)

    const { released, error } = await releaseQueuedGenerations(admin, {
      projectId,
      generationIds: [startedGen, queuedGen],
      error: 'Not reached before the run ended',
    })
    expect(error).toBeNull()
    expect(released).toEqual([queuedGen])
    const rows = await claims(projectId)
    expect(rows.find((c) => c.id === startedGen)!.state).toBe('generating')
    expect(rows.find((c) => c.id === queuedGen)!.state).toBe('failed')
    await releaseClaims(projectId)
  })
})

test.describe('storyboard images - status and staleness', () => {
  test('deriveImageState: queued, generating, and both windows reading as failed', () => {
    const now = Date.now()
    const shot = { image_path: null, image_stale: false }
    const ago = (ms: number) => new Date(now - ms).toISOString()

    expect(deriveImageState(shot, null, now)).toBe('not_generated')
    expect(deriveImageState({ image_path: 'x', image_stale: false }, null, now)).toBe('ready')
    expect(deriveImageState({ image_path: 'x', image_stale: true }, null, now)).toBe('stale')
    expect(deriveImageState(shot, { state: 'generating', started_at: ago(0), queued_at: ago(0) }, now)).toBe('queued')
    expect(deriveImageState(shot, { state: 'generating', started_at: ago(1000), queued_at: null }, now)).toBe(
      'generating'
    )
    expect(
      deriveImageState(shot, { state: 'generating', started_at: ago(IMAGE_STALE_AFTER_MS + 1), queued_at: null }, now)
    ).toBe('failed')
    // A queued row is judged on the queue window, not the per-call one.
    const longQueued = ago(IMAGE_STALE_AFTER_MS + 1)
    expect(deriveImageState(shot, { state: 'generating', started_at: longQueued, queued_at: longQueued }, now)).toBe(
      'queued'
    )
    const expiredQueued = ago(IMAGE_QUEUE_STALE_AFTER_MS + 1)
    expect(
      deriveImageState(shot, { state: 'generating', started_at: expiredQueued, queued_at: expiredQueued }, now)
    ).toBe('failed')
    expect(deriveImageState({ image_path: 'x', image_stale: false }, { state: 'failed', started_at: null, queued_at: null }, now)).toBe(
      'failed'
    )
  })

  test('a started claim stuck past the window reads failed, is reclaimable, and was never charged', async () => {
    const projectId = await seedProject(primary.user.id)
    const [shotId] = await seedShots(projectId, 1)
    const stuck = new Date(Date.now() - IMAGE_STALE_AFTER_MS - 5000).toISOString()
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'storyboard',
      operation: 'generate_image',
      shot_id: shotId,
      element_id: null,
      state: 'generating',
      payload: null,
      started_at: stuck,
      queued_at: null,
      updated_at: stuck,
    })

    const status = await loadImageStatuses({ supabase: admin, projectId, userId: primary.user.id, getBalance: realGetBalance })
    expect(status.ok && status.data.shots).toEqual([
      expect.objectContaining({ shotId, state: 'failed', imagePath: null, imageUrl: null, thumbUrl: null, drawnAt: null }),
    ])
    expect(await ledgerRows(projectId)).toHaveLength(0)

    const reclaim = await claimGeneration({
      supabase: admin,
      identity: { projectId, step: 'storyboard', operation: 'generate_image', shotId, elementId: null },
      retry: true,
      queued: true,
    })
    expect(reclaim.outcome).toBe('claimed')
    await releaseClaims(projectId)
  })
})

test.describe('storyboard images - thumbnails and signed status', () => {
  function status(projectId: string) {
    return loadImageStatuses({ supabase: admin, projectId, userId: primary.user.id, getBalance: realGetBalance })
  }

  test('a drawn image gets a lane thumbnail beside it, at the configured width', async () => {
    const projectId = await seedProject(primary.user.id, '9:16')
    const [shotId] = await seedShots(projectId, 1)
    await generate(primary.user.id, projectId, [shotId], successImageGateway())

    const { image_path } = await shotRow(shotId)
    const thumbPath = storyboardThumbPath(image_path!)
    expect(thumbPath).toBe(image_path!.replace(/\.webp$/, '_thumb.webp'))
    const { data: blob, error } = await admin.storage.from('artifacts').download(thumbPath)
    expect(error).toBeNull()
    const meta = await sharp(Buffer.from(await blob!.arrayBuffer())).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(STORYBOARD_THUMB_WIDTH)
    // Same ratio as the full image: 1008x1792 scaled to the thumbnail width.
    expect(meta.height).toBe(Math.round((1792 * STORYBOARD_THUMB_WIDTH) / 1008))
  })

  test('status signs the full image and thumbnail in one read, with drawnAt, expiry and balance', async () => {
    const projectId = await seedProject(primary.user.id)
    const [shotId] = await seedShots(projectId, 1)
    await generate(primary.user.id, projectId, [shotId], successImageGateway())
    const { image_path } = await shotRow(shotId)

    // Read before the status call: parallel specs only ever spend primary's balance, so the
    // ledger as it stood beforehand bounds the figure the status read computes after it.
    const ledgerBefore = await realGetBalance(primary.user.id)
    const before = Date.now()
    const result = await status(projectId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [shot] = result.data.shots
    expect(shot).toMatchObject({ shotId, state: 'ready', imagePath: image_path })
    expect(shot.imageUrl).toContain(encodeURI(image_path!).split('/').pop()!)
    expect(shot.thumbUrl).toContain('_thumb.webp')
    // Both URLs actually resolve.
    expect((await fetch(shot.imageUrl!)).status).toBe(200)
    expect((await fetch(shot.thumbUrl!)).status).toBe(200)

    const { data: claim } = await admin
      .from('generations')
      .select('updated_at')
      .eq('project_id', projectId)
      .eq('shot_id', shotId)
      .single()
    expect(shot.drawnAt).toBe(claim!.updated_at)
    const expiresIn = new Date(result.data.expiresAt).getTime() - before
    expect(expiresIn).toBeGreaterThan((STORYBOARD_SIGNED_URL_EXPIRES_S - 5) * 1000)
    expect(expiresIn).toBeGreaterThan(result.data.pollIntervalMs * 100)
    // primary is shared across parallel specs, whose live claims lower this figure - so it
    // is bounded by the ledger, never asserted exactly.
    expect(typeof result.data.balanceCredits).toBe('number')
    expect(result.data.balanceCredits!).toBeGreaterThanOrEqual(0)
    expect(result.data.balanceCredits!).toBeLessThanOrEqual(ledgerBefore)
  })

  test('an image with no thumbnail still signs the full image, and thumbUrl is null', async () => {
    const projectId = await seedProject(primary.user.id)
    const [shotId] = await seedShots(projectId, 1)
    await generate(primary.user.id, projectId, [shotId], successImageGateway())
    const { image_path } = await shotRow(shotId)
    await admin.storage.from('artifacts').remove([storyboardThumbPath(image_path!)])

    const result = await status(projectId)
    expect(result.ok && result.data.shots[0]).toMatchObject({ state: 'ready', thumbUrl: null })
    expect(result.ok && result.data.shots[0].imageUrl).toBeTruthy()
  })

  test('an in-flight claim reports its timestamps and counts against the balance', async () => {
    const projectId = await seedProject(primary.user.id)
    const [queuedShot, startedShot] = await seedShots(projectId, 2)
    const now = new Date().toISOString()
    await admin.from('generations').insert([
      { project_id: projectId, step: 'storyboard', operation: 'generate_image', shot_id: queuedShot, element_id: null, state: 'generating', started_at: now, queued_at: now },
      { project_id: projectId, step: 'storyboard', operation: 'generate_image', shot_id: startedShot, element_id: null, state: 'generating', started_at: now, queued_at: null },
    ])
    try {
      const result = await status(projectId)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const byId = new Map(result.data.shots.map((s) => [s.shotId, s]))
      expect(byId.get(queuedShot)).toMatchObject({ state: 'queued', queuedAt: expect.any(String), startedAt: expect.any(String) })
      expect(byId.get(startedShot)).toMatchObject({ state: 'generating', queuedAt: null, startedAt: expect.any(String) })
      const ledger = await realGetBalance(primary.user.id)
      // Other specs may hold live claims of their own, so the figure is at most ledger - 2 x price.
      expect(result.data.balanceCredits!).toBeLessThanOrEqual(Math.max(0, ledger - 2 * PRICE))
    } finally {
      await releaseClaims(projectId)
    }
  })
})
