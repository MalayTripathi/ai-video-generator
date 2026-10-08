import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { fixedCredits } from './helpers/prices'
import { runAdvanceToVideoPrompts } from '../src/app/api/projects/[id]/video_prompts/advance/logic'
import type { getBalance as getBalanceType } from '../src/lib/credits/balance'
import type { ensureSignupGrant as ensureSignupGrantType } from '../src/lib/credits/signup-grant'

// The per-shot price is read from the config, never restated here: a re-priced step must
// not turn these tests red for the wrong reason.
const PER_SHOT = fixedCredits('video_prompts', 'write_video_prompts')
const STORYBOARD = stepIndex('storyboard')
const VIDEO_PROMPTS = stepIndex('video_prompts')

// The balance is injected, so these run on the fixed primary user without reading or
// draining its real balance: the real getBalance/ensureSignupGrant pair is covered by
// image-prompts-advance.spec.ts and storyboard-advance.spec.ts, which share this shape.
const balanceOf =
  (credits: number): typeof getBalanceType =>
  async () =>
    credits
const noBalanceRead: typeof getBalanceType = async () => {
  throw new Error('getBalance must not be called')
}
const noopEnsureSignupGrant: typeof ensureSignupGrantType = async () => {}

type ShotSpec = { image?: boolean; stale?: boolean; binned?: boolean; generating?: boolean }

async function seed(opts: { furthestStep: number; shots: ShotSpec[] }) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Video prompts advance test',
      source_text: 'A short film for video-prompts-advance tests.',
      video_type: 'auto',
      duration_target: '30-60s',
      status: 'in_progress',
      current_step: 'storyboard',
      furthest_step: opts.furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string

  if (opts.shots.length === 0) return { projectId, ids: [] as string[] }
  const rows = opts.shots.map((spec, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: `v${String(i).padStart(4, '0')}`,
    voice_over: 'Placeholder voice-over.',
    image_prompt: 'A lighthouse at dusk.',
    // A path only needs to exist on the row for readiness; nothing here signs it.
    image_path: spec.image === false ? null : `${primary.user.id}/${projectId}/images/${i}.webp`,
    image_stale: spec.stale ?? false,
    binned_at: spec.binned ? new Date().toISOString() : null,
  }))
  const { data: shots, error: shotsError } = await admin.from('shots').insert(rows).select('id, order_index')
  expect(shotsError).toBeNull()
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id as string)

  const claims = opts.shots.flatMap((spec, i) =>
    spec.generating
      ? [
          {
            project_id: projectId,
            step: 'storyboard',
            operation: 'generate_image',
            shot_id: ids[i],
            element_id: null,
            state: 'generating',
            started_at: new Date().toISOString(),
            queued_at: null,
          },
        ]
      : []
  )
  if (claims.length > 0) {
    const { error: claimError } = await admin.from('generations').insert(claims)
    expect(claimError).toBeNull()
  }
  return { projectId, ids }
}

async function readProject(projectId: string) {
  const { data, error } = await admin
    .from('projects')
    .select('current_step, furthest_step, status')
    .eq('id', projectId)
    .single()
  expect(error).toBeNull()
  return data!
}

async function spendRowsFor(projectId: string) {
  const [{ count: ledger }, { count: usage }] = await Promise.all([
    admin.from('credit_ledger').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
    admin.from('usage').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
  ])
  return { ledger, usage }
}

function run(projectId: string, getBalance: typeof getBalanceType, userId = primary.user.id) {
  return runAdvanceToVideoPrompts({
    supabase: admin,
    projectId,
    userId,
    getBalance,
    ensureSignupGrant: noopEnsureSignupGrant,
  })
}

test.describe('runAdvanceToVideoPrompts', () => {
  test('sufficient balance advances, prices only the in-film shots, and writes no spend row', async () => {
    // The binned shot has no image: it neither counts toward N nor blocks readiness. A
    // stale frame still has an image, so it is ready.
    const { projectId } = await seed({
      furthestStep: STORYBOARD,
      shots: [{}, { stale: true }, {}, { binned: true, image: false }],
    })

    const result = await run(projectId, balanceOf(3 * PER_SHOT))

    expect(result).toEqual({ ok: true, status: 200, data: { requiredCredits: 3 * PER_SHOT } })
    expect(await readProject(projectId)).toEqual({
      current_step: 'video_prompts',
      furthest_step: VIDEO_PROMPTS,
      status: 'in_progress',
    })
    expect(await spendRowsFor(projectId)).toEqual({ ledger: 0, usage: 0 })
  })

  test('insufficient balance returns 402 with the numbers and leaves the project and ledger untouched', async () => {
    const { projectId } = await seed({ furthestStep: STORYBOARD, shots: [{}, {}] })

    const result = await run(projectId, balanceOf(2 * PER_SHOT - 1))

    expect(result).toMatchObject({ ok: false, status: 402, requiredCredits: 2 * PER_SHOT, balanceCredits: 2 * PER_SHOT - 1 })
    expect(await readProject(projectId)).toMatchObject({ current_step: 'storyboard', furthest_step: STORYBOARD })
    expect(await spendRowsFor(projectId)).toEqual({ ledger: 0, usage: 0 })
  })

  test('refuses with 422 when an in-film frame has no image, naming it, before any balance read', async () => {
    const { projectId, ids } = await seed({ furthestStep: STORYBOARD, shots: [{}, { image: false }] })

    const result = await run(projectId, noBalanceRead)

    expect(result).toMatchObject({ ok: false, status: 422, reason: 'frames_not_ready', shotIds: [ids[1]] })
    expect(await readProject(projectId)).toMatchObject({ current_step: 'storyboard', furthest_step: STORYBOARD })
  })

  test('refuses with 422 when a frame is still in flight, even though an older image exists', async () => {
    const { projectId, ids } = await seed({ furthestStep: STORYBOARD, shots: [{ generating: true }, {}] })

    const result = await run(projectId, noBalanceRead)

    expect(result).toMatchObject({ ok: false, status: 422, reason: 'frames_not_ready', shotIds: [ids[0]] })
    expect(await readProject(projectId)).toMatchObject({ furthest_step: STORYBOARD })
  })

  test('refuses with 422 when there are no in-film shots - none at all, or every one binned', async () => {
    const empty = await seed({ furthestStep: STORYBOARD, shots: [] })
    expect(await run(empty.projectId, noBalanceRead)).toMatchObject({ ok: false, status: 422, reason: 'no_shots' })

    const allBinned = await seed({ furthestStep: STORYBOARD, shots: [{ binned: true }, { binned: true }] })
    expect(await run(allBinned.projectId, noBalanceRead)).toMatchObject({ ok: false, status: 422, reason: 'no_shots' })
    expect(await readProject(allBinned.projectId)).toMatchObject({ furthest_step: STORYBOARD })
  })

  test('past the frontier it advances with no balance check and no readiness gate', async () => {
    const { projectId } = await seed({ furthestStep: VIDEO_PROMPTS, shots: [{ image: false }] })

    const result = await run(projectId, noBalanceRead)

    expect(result).toMatchObject({ ok: true, status: 200 })
    expect(await readProject(projectId)).toMatchObject({ current_step: 'video_prompts', furthest_step: VIDEO_PROMPTS })
    expect(await spendRowsFor(projectId)).toEqual({ ledger: 0, usage: 0 })
  })

  test("another user's project is a 404", async () => {
    const { projectId } = await seed({ furthestStep: STORYBOARD, shots: [{}] })

    const result = await run(projectId, noBalanceRead, crypto.randomUUID())

    expect(result).toMatchObject({ ok: false, status: 404 })
  })
})
