import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { advanceStep } from '../src/lib/projects/advance-step'

async function insertProject(userId: string, currentStep: string, furthestStep: number, status?: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Untitled project',
      current_step: currentStep,
      furthest_step: furthestStep,
      ...(status ? { status } : {}),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
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

test.describe('advanceStep', () => {
  test('forward advance sets both current_step and furthest_step', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id, 'workbench', 2)

    await advanceStep(admin, projectId, 'image_prompts')

    const project = await readProject(projectId)
    expect(project.current_step).toBe('image_prompts')
    expect(project.furthest_step).toBe(3)
  })

  test('backward navigation regresses current_step and leaves furthest_step untouched', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id, 'image_prompts', 3)

    await advanceStep(admin, projectId, 'workbench')

    const project = await readProject(projectId)
    expect(project.current_step).toBe('workbench')
    expect(project.furthest_step).toBe(3)
  })

  test('re-advancing to an already-unlocked step does not change furthest_step', async () => {
    const user = primary.user
    const projectId = await insertProject(user.id, 'workbench', 3)

    await advanceStep(admin, projectId, 'image_prompts')

    const project = await readProject(projectId)
    expect(project.current_step).toBe('image_prompts')
    expect(project.furthest_step).toBe(3)
  })

  test('leaving the workbench moves a draft project to in_progress', async () => {
    const projectId = await insertProject(primary.user.id, 'workbench', 2, 'draft')

    await advanceStep(admin, projectId, 'image_prompts')

    expect((await readProject(projectId)).status).toBe('in_progress')
  })

  test('status is left alone when it is not draft, and when navigating back to the workbench', async () => {
    const completedId = await insertProject(primary.user.id, 'workbench', 2, 'completed')
    await advanceStep(admin, completedId, 'image_prompts')
    expect((await readProject(completedId)).status).toBe('completed')

    const draftId = await insertProject(primary.user.id, 'image_prompts', 3, 'draft')
    await advanceStep(admin, draftId, 'workbench')
    expect((await readProject(draftId)).status).toBe('draft')
  })
})
