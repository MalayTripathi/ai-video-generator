import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { successMessage } from './helpers/claude-fakes'
import type { ClaudeGateway } from '../src/lib/claude'
import { runImagePromptGeneration } from '../src/app/api/projects/[id]/image-prompts/logic'
import { updateShotImagePromptForUser } from '../src/app/(app)/projects/[id]/image_prompts/actions'
import {
  bindElementToShotForUser,
  unbindElementFromShotForUser,
} from '../src/app/(app)/projects/[id]/workbench/actions'
import { uploadReferenceImageForUser, removeReferenceImageForUser } from '../src/lib/elements/reference'

// shots.image_stale: set at every write site that changes what a storyboard image would
// be drawn from, only on a real change; cleared only by storing a new image (covered in
// storyboard-images.spec.ts, where the worker does that write).

const PROMPT_A =
  'A warm, detailed shot with rich color and lighting that fully describes the moment for an image generation model.'
const PROMPT_B =
  'A cool, moonlit shot with deep blue shadows and a single lamp that fully describes the moment for the image model.'

async function seedProject(furthestStep: number = stepIndex('image_prompts')) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'image_stale test',
      current_step: 'image_prompts',
      furthest_step: furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShot(projectId: string, imagePrompt: string | null, shotKey: string) {
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: 0,
      shot_key: shotKey,
      voice_over: 'Voice over.',
      image_prompt: imagePrompt,
      image_path: `${primary.user.id}/${projectId}/images/placeholder/existing.webp`,
      image_stale: false,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedElement(projectId: string) {
  const { data, error } = await admin
    .from('elements')
    .insert({ project_id: projectId, name: `Element ${crypto.randomUUID()}`, type: 'character' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function imageStale(shotId: string): Promise<boolean> {
  const { data, error } = await admin.from('shots').select('image_stale').eq('id', shotId).single()
  expect(error).toBeNull()
  return data!.image_stale
}

async function resetImageStale(shotId: string) {
  const { error } = await admin.from('shots').update({ image_stale: false }).eq('id', shotId)
  expect(error).toBeNull()
}

function promptsGateway(shotKey: string, imagePrompt: string): ClaudeGateway {
  return {
    async createMessage() {
      return successMessage({ prompts: [{ shot_key: shotKey, image_prompt: imagePrompt }] }, 'write_image_prompts')
    },
  }
}

async function runPrompts(projectId: string, shotId: string, gateway: ClaudeGateway) {
  return runImagePromptGeneration({
    gateway,
    supabase: admin,
    projectId,
    userId: primary.user.id,
    shotIds: [shotId],
    retry: true,
    attemptId: crypto.randomUUID(),
    recordFixedSpend: async () => {},
    getBalance: async () => 999999,
    ensureSignupGrant: async () => {},
  })
}

test.describe('image_stale write sites', () => {
  test('image-prompts route: a changed prompt sets it, an identical one does not', async () => {
    const projectId = await seedProject()
    const shotKey = 'wxzbc'
    const shotId = await seedShot(projectId, PROMPT_A, shotKey)

    const same = await runPrompts(projectId, shotId, promptsGateway(shotKey, PROMPT_A))
    expect(same.ok).toBe(true)
    expect(await imageStale(shotId)).toBe(false)

    const changed = await runPrompts(projectId, shotId, promptsGateway(shotKey, PROMPT_B))
    expect(changed.ok).toBe(true)
    expect(await imageStale(shotId)).toBe(true)
  })

  test('manual prompt edit: a real change sets it, a no-op edit leaves it unchanged', async () => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, PROMPT_A, 'mnpqr')

    const noop = await updateShotImagePromptForUser(admin, shotId, `  ${PROMPT_A}  `, primary.user.id)
    expect(noop.success).toBe(true)
    expect(await imageStale(shotId)).toBe(false)

    const edit = await updateShotImagePromptForUser(admin, shotId, PROMPT_B, primary.user.id)
    expect(edit.success).toBe(true)
    expect(await imageStale(shotId)).toBe(true)
  })

  test('element bind and unbind each set it on that shot', async () => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, PROMPT_A, 'bcdfg')
    const elementId = await seedElement(projectId)

    const bound = await bindElementToShotForUser(admin, shotId, elementId, primary.user.id, 'image_prompts')
    expect(bound.success).toBe(true)
    expect(await imageStale(shotId)).toBe(true)

    await resetImageStale(shotId)
    const unbound = await unbindElementFromShotForUser(admin, shotId, elementId, primary.user.id, 'image_prompts')
    expect(unbound.success).toBe(true)
    expect(await imageStale(shotId)).toBe(true)
  })

  test('reference image add, replace and remove each set it on bound shots', async () => {
    const projectId = await seedProject()
    const shotId = await seedShot(projectId, PROMPT_A, 'hjkmn')
    const elementId = await seedElement(projectId)
    const { error: bindError } = await admin.from('shot_elements').insert({ shot_id: shotId, element_id: elementId })
    expect(bindError).toBeNull()

    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer()

    const added = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, png)
    expect(added.success).toBe(true)
    expect(await imageStale(shotId)).toBe(true)

    await resetImageStale(shotId)
    const replaced = await uploadReferenceImageForUser(admin, projectId, elementId, primary.user.id, png)
    expect(replaced.success).toBe(true)
    expect(await imageStale(shotId)).toBe(true)

    await resetImageStale(shotId)
    const removed = await removeReferenceImageForUser(admin, projectId, elementId, primary.user.id)
    expect(removed.success).toBe(true)
    expect(await imageStale(shotId)).toBe(true)
  })
})
