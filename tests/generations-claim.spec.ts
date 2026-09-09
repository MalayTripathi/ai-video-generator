import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { claimGeneration } from '../src/lib/generations/claim'
import { STALE_AFTER_MS } from '../src/lib/generations/operation-policy'

async function insertProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Untitled project',
      current_step: 'workbench',
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

const IDENTITY = { step: 'workbench', operation: 'generate_shots', shotId: null } as const

test.describe('generations claim primitives', () => {
  test('two concurrent claims on a fresh identity: exactly one claims, the other is blocked as already_generating', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)

      const [first, second] = await Promise.all([
        claimGeneration({ supabase: admin, identity: { projectId, ...IDENTITY }, retry: false }),
        claimGeneration({ supabase: admin, identity: { projectId, ...IDENTITY }, retry: false }),
      ])

      const outcomes = [first.outcome, second.outcome].sort()
      expect(outcomes).toEqual(['blocked', 'claimed'])
      const blocked = [first, second].find((r) => r.outcome === 'blocked')
      expect(blocked && blocked.outcome === 'blocked' && blocked.reason).toBe('already_generating')
    }
  })

  test('two raw inserts with shot_id null for the same (project, step, operation) collide on NULLS NOT DISTINCT', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)

      const first = await admin.from('generations').insert({
        project_id: projectId,
        step: 'workbench',
        operation: 'generate_shots',
        shot_id: null,
        state: 'generating',
      })
      expect(first.error).toBeNull()

      const second = await admin.from('generations').insert({
        project_id: projectId,
        step: 'workbench',
        operation: 'generate_shots',
        shot_id: null,
        state: 'generating',
      })

      expect(second.error).not.toBeNull()
      expect(second.error?.code).toBe('23505')
    }
  })

  test('a generating row older than STALE_AFTER_MS is reclaimable; one younger is not', async () => {
    const user = primary.user
    {
      const staleProjectId = await insertProject(user.id)
      const staleTimestamp = new Date(Date.now() - (STALE_AFTER_MS + 5 * 60 * 1000)).toISOString()
      await admin.from('generations').insert({
        project_id: staleProjectId,
        step: 'workbench',
        operation: 'generate_shots',
        shot_id: null,
        state: 'generating',
        started_at: staleTimestamp,
      })

      const staleResult = await claimGeneration({
        supabase: admin,
        identity: { projectId: staleProjectId, ...IDENTITY },
        retry: false,
      })
      expect(staleResult.outcome).toBe('claimed')

      const freshProjectId = await insertProject(user.id)
      const freshTimestamp = new Date(Date.now() - (STALE_AFTER_MS - 5 * 60 * 1000)).toISOString()
      await admin.from('generations').insert({
        project_id: freshProjectId,
        step: 'workbench',
        operation: 'generate_shots',
        shot_id: null,
        state: 'generating',
        started_at: freshTimestamp,
      })

      const freshResult = await claimGeneration({
        supabase: admin,
        identity: { projectId: freshProjectId, ...IDENTITY },
        retry: false,
      })
      expect(freshResult.outcome).toBe('blocked')
      expect(freshResult.outcome === 'blocked' && freshResult.reason).toBe('already_generating')
    }
  })

  test('reclaiming a row already reclaimed by a concurrent caller affects zero rows and returns blocked', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await admin.from('generations').insert({
        project_id: projectId,
        step: 'workbench',
        operation: 'generate_shots',
        shot_id: null,
        state: 'failed',
      })

      const [first, second] = await Promise.all([
        claimGeneration({ supabase: admin, identity: { projectId, ...IDENTITY }, retry: true }),
        claimGeneration({ supabase: admin, identity: { projectId, ...IDENTITY }, retry: true }),
      ])

      const outcomes = [first.outcome, second.outcome].sort()
      expect(outcomes).toEqual(['blocked', 'claimed'])
      const blocked = [first, second].find((r) => r.outcome === 'blocked')
      expect(blocked && blocked.outcome === 'blocked' && blocked.reason).toBe('already_generating')
    }
  })

  test('a backfilled pending row is always reclaimable, matching the old shots_generation.eq.pending branch', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await admin.from('generations').insert({
        project_id: projectId,
        step: 'workbench',
        operation: 'generate_shots',
        shot_id: null,
        state: 'pending',
      })

      const result = await claimGeneration({
        supabase: admin,
        identity: { projectId, ...IDENTITY },
        retry: false,
      })
      expect(result.outcome).toBe('claimed')
    }
  })
})

const AGENT_TURN_IDENTITY = { step: 'workbench', operation: 'agent_turn', shotId: null } as const
const AGENT_TURN_STALE_AFTER_MS = 180 * 1000

test.describe('OPERATION_POLICY-driven claim behaviour', () => {
  test('agent_turn is claimable from succeeded with no retry flag - a mutex, not a job record', async () => {
    const projectId = await insertProject(primary.user.id)
    await admin
      .from('generations')
      .insert({ project_id: projectId, step: 'workbench', operation: 'agent_turn', shot_id: null, state: 'succeeded' })

    const result = await claimGeneration({
      supabase: admin,
      identity: { projectId, ...AGENT_TURN_IDENTITY },
      retry: false,
    })
    expect(result.outcome).toBe('claimed')
  })

  test('agent_turn is claimable from failed with no retry flag', async () => {
    const projectId = await insertProject(primary.user.id)
    await admin
      .from('generations')
      .insert({ project_id: projectId, step: 'workbench', operation: 'agent_turn', shot_id: null, state: 'failed' })

    const result = await claimGeneration({
      supabase: admin,
      identity: { projectId, ...AGENT_TURN_IDENTITY },
      retry: false,
    })
    expect(result.outcome).toBe('claimed')
  })

  test('a generating agent_turn row is refused before 180s and reclaimable after', async () => {
    const freshProjectId = await insertProject(primary.user.id)
    const freshTimestamp = new Date(Date.now() - (AGENT_TURN_STALE_AFTER_MS - 30 * 1000)).toISOString()
    await admin.from('generations').insert({
      project_id: freshProjectId,
      step: 'workbench',
      operation: 'agent_turn',
      shot_id: null,
      state: 'generating',
      started_at: freshTimestamp,
    })

    const freshResult = await claimGeneration({
      supabase: admin,
      identity: { projectId: freshProjectId, ...AGENT_TURN_IDENTITY },
      retry: false,
    })
    expect(freshResult.outcome).toBe('blocked')
    expect(freshResult.outcome === 'blocked' && freshResult.reason).toBe('already_generating')

    const staleProjectId = await insertProject(primary.user.id)
    const staleTimestamp = new Date(Date.now() - (AGENT_TURN_STALE_AFTER_MS + 30 * 1000)).toISOString()
    await admin.from('generations').insert({
      project_id: staleProjectId,
      step: 'workbench',
      operation: 'agent_turn',
      shot_id: null,
      state: 'generating',
      started_at: staleTimestamp,
    })

    const staleResult = await claimGeneration({
      supabase: admin,
      identity: { projectId: staleProjectId, ...AGENT_TURN_IDENTITY },
      retry: false,
    })
    expect(staleResult.outcome).toBe('claimed')
  })

  test('generate_shots from succeeded is blocked without retry (retry_required) and claimed with it - regenerate-all', async () => {
    const projectId = await insertProject(primary.user.id)
    await admin.from('generations').insert({
      project_id: projectId,
      step: 'workbench',
      operation: 'generate_shots',
      shot_id: null,
      state: 'succeeded',
    })

    const withoutRetry = await claimGeneration({
      supabase: admin,
      identity: { projectId, ...IDENTITY },
      retry: false,
    })
    expect(withoutRetry.outcome).toBe('blocked')
    expect(withoutRetry.outcome === 'blocked' && withoutRetry.reason).toBe('retry_required')

    const withRetry = await claimGeneration({
      supabase: admin,
      identity: { projectId, ...IDENTITY },
      retry: true,
    })
    expect(withRetry.outcome).toBe('claimed')
  })
})
