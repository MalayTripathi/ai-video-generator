import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { runShotGeneration } from '../src/app/api/projects/[id]/shots/logic'
import { STALE_AFTER_MS } from '../src/lib/generations/claim'
import { successMessage, truncatedMessage, throwingGateway } from './helpers/claude-fakes'
import type { ClaudeGateway } from '../src/lib/claude'

const VALID_WRITE_SHOTS_INPUT = {
  title: 'A short film',
  message: 'Here is your shot list.',
  video_type: 'narrated_story',
  shots: [
    {
      voice_over: 'Once upon a time, in a quiet valley.',
      visual_description: 'Wide shot of a castle at dawn.',
      shot_size: 'wide',
      camera_angle: 'eye_level',
      camera_movement: 'static',
      duration_sec: 5,
      section_label: 'Intro',
      dialogue: [],
      element_names: [],
    },
  ],
}

function countingGateway(result: Awaited<ReturnType<ClaudeGateway['createMessage']>>) {
  let callCount = 0
  const gateway: ClaudeGateway = {
    async createMessage() {
      callCount++
      return result
    },
  }
  return { gateway, getCallCount: () => callCount }
}

async function insertProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Untitled project',
      source_text: 'A short film about a quiet valley.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedGeneration(
  projectId: string,
  overrides: {
    state: 'pending' | 'generating' | 'succeeded' | 'failed'
    started_at?: string | null
    payload?: unknown
  }
) {
  const { error } = await admin.from('generations').insert({
    project_id: projectId,
    step: 'workbench',
    operation: 'generate_shots',
    shot_id: null,
    state: overrides.state,
    started_at: overrides.started_at ?? null,
    payload: (overrides.payload ?? null) as never,
  })
  expect(error).toBeNull()
}

async function readGeneration(projectId: string) {
  const { data } = await admin
    .from('generations')
    .select('state, started_at, payload')
    .eq('project_id', projectId)
    .eq('step', 'workbench')
    .eq('operation', 'generate_shots')
    .is('shot_id', null)
    .single()
  return data!
}

test.describe('shot generation state machine', () => {
  test('claim refused when succeeded - 409 already_ready, gateway never called', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await seedGeneration(projectId, { state: 'succeeded' })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect('reason' in result && result.reason).toBe('already_ready')
      }
      expect(getCallCount()).toBe(0)
    }
  })

  test('claim refused when generating and fresh - 409 already_generating, gateway never called', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await seedGeneration(projectId, { state: 'generating', started_at: new Date().toISOString() })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect('reason' in result && result.reason).toBe('already_generating')
      }
      expect(getCallCount()).toBe(0)
    }
  })

  test('claim refused when generating and not yet stale - 409 already_generating, gateway never called', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const notYetStale = new Date(Date.now() - (STALE_AFTER_MS - 5 * 60 * 1000)).toISOString()
      await seedGeneration(projectId, { state: 'generating', started_at: notYetStale })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect('reason' in result && result.reason).toBe('already_generating')
      }
      expect(getCallCount()).toBe(0)
    }
  })

  test('claim succeeds when generating and stale - gateway called once, ends succeeded', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const staleTimestamp = new Date(Date.now() - (STALE_AFTER_MS + 5 * 60 * 1000)).toISOString()
      await seedGeneration(projectId, { state: 'generating', started_at: staleTimestamp })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(true)
      expect(getCallCount()).toBe(1)
      const row = await readGeneration(projectId)
      expect(row.state).toBe('succeeded')
    }
  })

  test('claim refused when failed without retry - 409 retry_required, gateway never called', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await seedGeneration(projectId, { state: 'failed' })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect('reason' in result && result.reason).toBe('retry_required')
      }
      expect(getCallCount()).toBe(0)
    }
  })

  test('claim succeeds when failed with retry and no pending payload - gateway called once, ends succeeded', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await seedGeneration(projectId, { state: 'failed', payload: null })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: true })

      expect(result.ok).toBe(true)
      expect(getCallCount()).toBe(1)
      const row = await readGeneration(projectId)
      expect(row.state).toBe('succeeded')
    }
  })

  test('recovery replays a pending payload without calling the gateway again, replacing any existing shots', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await seedGeneration(projectId, { state: 'failed', payload: VALID_WRITE_SHOTS_INPUT })

      // Simulate the shots a prior (truncated/partial) attempt left behind - the replay
      // must replace these, not collide with or accumulate alongside them.
      const { error: seedError } = await admin.from('shots').insert([
        { project_id: projectId, order_index: 0, shot_key: 'bbbbb', voice_over: 'stale first attempt' },
        { project_id: projectId, order_index: 1, shot_key: 'ccccc', voice_over: 'stale second attempt' },
      ])
      expect(seedError).toBeNull()

      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: true })

      expect(result.ok).toBe(true)
      // The critical assertion: RECOVER never touches the gateway, since Claude already
      // answered (and was already paid for) on the attempt that wrote the payload.
      expect(getCallCount()).toBe(0)

      const { data: shots } = await admin.from('shots').select('*').eq('project_id', projectId)
      // Exactly the replayed batch's count - not the sum of the 2 stale rows plus the
      // replay - proving the pipeline replaces the shot list wholesale rather than
      // accumulating onto whatever a prior attempt left behind.
      expect(shots?.length).toBe(VALID_WRITE_SHOTS_INPUT.shots.length)

      const row = await readGeneration(projectId)
      expect(row.state).toBe('succeeded')
      expect(row.payload).toBeNull()
    }
  })

  test('truncation (max_tokens) saves usable shots, ends failed, and clears the pending payload', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const { gateway } = countingGateway(truncatedMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(422)

      const { data: shots } = await admin.from('shots').select('*').eq('project_id', projectId)
      expect(shots?.length).toBe(VALID_WRITE_SHOTS_INPUT.shots.length)

      const row = await readGeneration(projectId)
      expect(row.state).toBe('failed')
      // Deliberate deviation from the general "leave payload intact on failure" rule: a
      // truncated answer was never a successful return, so a retry must ask Claude for a
      // fresh, complete list rather than replaying the same short one forever.
      expect(row.payload).toBeNull()
    }
  })

  test('full success sets succeeded and clears the payload', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const { gateway } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.status).toBe(200)
        expect(result.data.shots.length).toBe(VALID_WRITE_SHOTS_INPUT.shots.length)
      }

      const row = await readGeneration(projectId)
      expect(row.state).toBe('succeeded')
      expect(row.payload).toBeNull()
    }
  })

  test('a thrown exception mid-pipeline never leaves the project stuck generating', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const gateway = throwingGateway()

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(500)

      const row = await readGeneration(projectId)
      expect(row.state).toBe('failed')
    }
  })

  test('two concurrent requests on the same project: exactly one claims, the other is blocked, and only one Claude call is made', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const [first, second] = await Promise.all([
        runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false }),
        runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false }),
      ])

      const results = [first, second]
      const claimed = results.filter((r) => r.ok)
      const blocked = results.filter((r) => !r.ok)

      expect(claimed.length).toBe(1)
      expect(blocked.length).toBe(1)
      const blockedResult = blocked[0]
      if (!blockedResult.ok) {
        expect(blockedResult.status).toBe(409)
        expect('reason' in blockedResult && blockedResult.reason).toBe('already_generating')
      }
      expect(getCallCount()).toBe(1)
    }
  })
})
