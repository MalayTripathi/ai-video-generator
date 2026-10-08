import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'

// Step 5's shell: the shared chrome with a placeholder render area and an inert Continue.
// Nothing here reaches a provider.

const NAVIGATION = { timeout: 45000 }

async function seed(opts: { furthestStep: number; currentStep: string }) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Video prompts shell',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      aspect_ratio: '9:16',
      status: 'in_progress',
      current_step: opts.currentStep,
      furthest_step: opts.furthestStep,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  const { error: shotsError } = await admin.from('shots').insert(
    Array.from({ length: 2 }, (_, i) => ({
      project_id: projectId,
      order_index: i,
      shot_key: `vp${i}${Math.random().toString(36).slice(2, 4)}`,
      voice_over: `Line ${i + 1}.`,
      duration_sec: 5,
    }))
  )
  expect(shotsError).toBeNull()
  return projectId
}

test.describe('Step 5 video prompts shell', () => {
  test.setTimeout(120000)

  test('renders the shared shell with a placeholder and a disabled Continue to generation', { tag: '@smoke' }, async ({
    page,
  }) => {
    const projectId = await seed({ furthestStep: stepIndex('video_prompts'), currentStep: 'video_prompts' })

    await page.goto(`/projects/${projectId}/video_prompts`)
    await expect(page.getByTestId('video-prompts-placeholder')).toBeVisible(NAVIGATION)

    // The shell's own pieces: header, step indicator with Video Prompts current (not a
    // link), the agent panel, and the footer.
    await expect(page.getByText('Video prompts shell')).toBeVisible()
    const indicator = page.getByTestId('step-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator.locator(`a[href="/projects/${projectId}/storyboard"]`)).toHaveCount(1)
    await expect(indicator.locator(`a[href="/projects/${projectId}/video_prompts"]`)).toHaveCount(0)
    await expect(page.getByText('Agent', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Ask for a change')).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Continue to generation' })).toBeDisabled()
  })

  test('a project that has not reached Video Prompts is sent back to its current step', async ({ page }) => {
    const projectId = await seed({ furthestStep: stepIndex('storyboard'), currentStep: 'storyboard' })

    await page.goto(`/projects/${projectId}/video_prompts`)
    await expect(page).toHaveURL(`/projects/${projectId}/storyboard`, NAVIGATION)
    await expect(page.getByTestId('video-prompts-placeholder')).toHaveCount(0)
  })
})
