import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { advanceStep } from '../src/lib/projects/advance-step'

async function insertProject(userId: string, currentStep: string, furthestStep: number) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Untitled project',
      current_step: currentStep,
      furthest_step: furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function readProject(projectId: string) {
  const { data, error } = await admin
    .from('projects')
    .select('current_step, furthest_step')
    .eq('id', projectId)
    .single()
  expect(error).toBeNull()
  return data!
}

test.describe('advanceStep', () => {
  test('forward advance sets both current_step and furthest_step', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id, 'workbench', 2)

    await advanceStep(admin, projectId, 'voiceover')

    const project = await readProject(projectId)
    expect(project.current_step).toBe('voiceover')
    expect(project.furthest_step).toBe(3)
  })

  test('backward navigation regresses current_step and leaves furthest_step untouched', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id, 'voiceover', 3)

    await advanceStep(admin, projectId, 'workbench')

    const project = await readProject(projectId)
    expect(project.current_step).toBe('workbench')
    expect(project.furthest_step).toBe(3)
  })

  test('re-advancing to an already-unlocked step does not change furthest_step', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id, 'workbench', 3)

    await advanceStep(admin, projectId, 'voiceover')

    const project = await readProject(projectId)
    expect(project.current_step).toBe('voiceover')
    expect(project.furthest_step).toBe(3)
  })
})
