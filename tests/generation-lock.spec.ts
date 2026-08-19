import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { acquireGenerationLock, releaseGenerationLock } from '../src/lib/generation-lock'

test.describe('generation lock', () => {
  test('a second concurrent acquire is rejected until the first releases', async () => {
    const { user } = await createTestSession()
    try {
      const { data: project, error } = await admin
        .from('projects')
        .insert({ user_id: user.id, title: 'Untitled project' })
        .select('id')
        .single()
      expect(error).toBeNull()

      const first = await acquireGenerationLock(admin, project!.id, user.id)
      expect(first).toBe(true)

      const second = await acquireGenerationLock(admin, project!.id, user.id)
      expect(second).toBe(false)

      await releaseGenerationLock(admin, project!.id)

      const third = await acquireGenerationLock(admin, project!.id, user.id)
      expect(third).toBe(true)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a stale lock self-heals instead of staying wedged forever', async () => {
    const { user } = await createTestSession()
    try {
      const { data: project, error } = await admin
        .from('projects')
        .insert({ user_id: user.id, title: 'Untitled project' })
        .select('id')
        .single()
      expect(error).toBeNull()

      const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      await admin.from('projects').update({ generating_at: staleTimestamp }).eq('id', project!.id)

      const acquired = await acquireGenerationLock(admin, project!.id, user.id)
      expect(acquired).toBe(true)
    } finally {
      await deleteTestUser(user.id)
    }
  })
})
