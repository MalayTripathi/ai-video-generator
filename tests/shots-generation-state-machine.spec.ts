import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { runShotGeneration, STALE_AFTER_MS } from '../src/app/api/projects/[id]/shots/logic'
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

async function insertProject(
  userId: string,
  overrides: {
    shots_generation: 'pending' | 'generating' | 'ready' | 'failed'
    generating_at?: string | null
    pending_shots_payload?: unknown
  }
) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Untitled project',
      source_text: 'A short film about a quiet valley.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
      shots_generation: overrides.shots_generation,
      generating_at: overrides.generating_at ?? null,
      pending_shots_payload: (overrides.pending_shots_payload ?? null) as never,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function readProject(projectId: string) {
  const { data } = await admin
    .from('projects')
    .select('shots_generation, generating_at, pending_shots_payload')
    .eq('id', projectId)
    .single()
  return data!
}

test.describe('shot generation state machine', () => {
  test('claim refused when ready - 409 already_ready, gateway never called', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id, { shots_generation: 'ready' })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect('reason' in result && result.reason).toBe('already_ready')
      }
      expect(getCallCount()).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('claim refused when generating and fresh - 409 already_generating, gateway never called', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id, {
        shots_generation: 'generating',
        generating_at: new Date().toISOString(),
      })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect('reason' in result && result.reason).toBe('already_generating')
      }
      expect(getCallCount()).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('claim refused when generating and not yet stale - 409 already_generating, gateway never called', async () => {
    const { user } = await createTestSession()
    try {
      const notYetStale = new Date(Date.now() - (STALE_AFTER_MS - 5 * 60 * 1000)).toISOString()
      const projectId = await insertProject(user.id, {
        shots_generation: 'generating',
        generating_at: notYetStale,
      })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect('reason' in result && result.reason).toBe('already_generating')
      }
      expect(getCallCount()).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('claim succeeds when generating and stale - gateway called once, ends ready', async () => {
    const { user } = await createTestSession()
    try {
      const staleTimestamp = new Date(Date.now() - (STALE_AFTER_MS + 5 * 60 * 1000)).toISOString()
      const projectId = await insertProject(user.id, {
        shots_generation: 'generating',
        generating_at: staleTimestamp,
      })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(true)
      expect(getCallCount()).toBe(1)
      const row = await readProject(projectId)
      expect(row.shots_generation).toBe('ready')
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('claim refused when failed without retry - 409 retry_required, gateway never called', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id, { shots_generation: 'failed' })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect('reason' in result && result.reason).toBe('retry_required')
      }
      expect(getCallCount()).toBe(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('claim succeeds when failed with retry and no pending payload - gateway called once, ends ready', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id, { shots_generation: 'failed', pending_shots_payload: null })
      const { gateway, getCallCount } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: true })

      expect(result.ok).toBe(true)
      expect(getCallCount()).toBe(1)
      const row = await readProject(projectId)
      expect(row.shots_generation).toBe('ready')
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('recovery replays a pending payload without calling the gateway again, replacing any existing shots', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id, {
        shots_generation: 'failed',
        pending_shots_payload: VALID_WRITE_SHOTS_INPUT,
      })

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

      const row = await readProject(projectId)
      expect(row.shots_generation).toBe('ready')
      expect(row.pending_shots_payload).toBeNull()
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('truncation (max_tokens) saves usable shots, ends failed, and clears the pending payload', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id, { shots_generation: 'pending' })
      const { gateway } = countingGateway(truncatedMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(422)

      const { data: shots } = await admin.from('shots').select('*').eq('project_id', projectId)
      expect(shots?.length).toBe(VALID_WRITE_SHOTS_INPUT.shots.length)

      const row = await readProject(projectId)
      expect(row.shots_generation).toBe('failed')
      // Deliberate deviation from the general "leave payload intact on failure" rule: a
      // truncated answer was never a successful return, so a retry must ask Claude for a
      // fresh, complete list rather than replaying the same short one forever.
      expect(row.pending_shots_payload).toBeNull()
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('full success sets ready and clears the payload', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id, { shots_generation: 'pending' })
      const { gateway } = countingGateway(successMessage(VALID_WRITE_SHOTS_INPUT))

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.status).toBe(200)
        expect(result.data.shots.length).toBe(VALID_WRITE_SHOTS_INPUT.shots.length)
      }

      const row = await readProject(projectId)
      expect(row.shots_generation).toBe('ready')
      expect(row.generating_at).toBeNull()
      expect(row.pending_shots_payload).toBeNull()
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a thrown exception mid-pipeline never leaves the project stuck generating', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id, { shots_generation: 'pending' })
      const gateway = throwingGateway()

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(500)

      const row = await readProject(projectId)
      expect(row.shots_generation).toBe('failed')
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
