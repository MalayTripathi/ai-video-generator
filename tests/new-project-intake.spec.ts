import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'
import { DEFAULT_DURATION_TARGET } from '../src/lib/config/duration'
import { DEFAULT_QUALITY_PRESET, QUALITY_PRESETS } from '../src/lib/config/models'

test.describe('New Project intake', () => {
  test('filling the brief and submitting creates a project and lands on workbench', { tag: '@smoke' }, async ({ page }) => {
    // The default browser identity (primary, via playwright.config.ts's storageState)
    // is already authenticated - no per-test createTestSession()/addCookies needed.
    const user = primary.user
    {
      // The workbench mounts a client effect that immediately POSTs to trigger shot
      // generation. Block it so this test's read of shots_generation is deterministic
      // and this intake test never itself reaches a state that triggers generation.
      await page.route('**/api/projects/*/shots', (route) => route.abort())
      await page.goto('/projects/new')

      const brief = 'A short video about the history of the Great Wall of China'
      await page.getByPlaceholder(/describe your idea/i).fill(brief)

      await page.getByRole('button', { name: 'Build workbench' }).click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/workbench$/, { waitUntil: 'commit' })

      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/workbench$/)?.[1]
      expect(projectId).toBeTruthy()

      const { data: project, error } = await admin
        .from('projects')
        .select('*')
        .eq('id', projectId!)
        .single()

      expect(error).toBeNull()
      expect(project.user_id).toBe(user.id)
      expect(project.title).toBeNull()
      expect(project.source_text).toBe(brief)
      expect(project.status).toBe('draft')
      expect(project.current_step).toBe('workbench')
      expect(project.furthest_step).toBe(2)
      expect(project.aspect_ratio).toBe('9:16')
      expect(project.duration_target).toBe(DEFAULT_DURATION_TARGET)
      expect(project.video_type).toBe('auto')
      expect(project.template_source_id).toBeNull()
      // No quality choice made: the default preset's four values.
      expect(project.quality_preset).toBe(DEFAULT_QUALITY_PRESET)
      expect(project.video_model).toBe(QUALITY_PRESETS[DEFAULT_QUALITY_PRESET].videoModel)
      expect(project.video_resolution).toBe(QUALITY_PRESETS[DEFAULT_QUALITY_PRESET].videoResolution)
      expect(project.image_quality).toBe(QUALITY_PRESETS[DEFAULT_QUALITY_PRESET].imageQuality)
      expect(project.image_model).toBe(QUALITY_PRESETS[DEFAULT_QUALITY_PRESET].imageModel)

      // The auto-trigger POST is blocked above, so no claim was ever attempted - a
      // brand-new project has no generations row until its first claim.
      const { data: generation, error: generationError } = await admin
        .from('generations')
        .select('id')
        .eq('project_id', projectId!)
        .eq('step', 'workbench')
        .eq('operation', 'generate_shots')
        .is('shot_id', null)
        .maybeSingle()
      expect(generationError).toBeNull()
      expect(generation).toBeNull()
    }
  })

  test('the build button stays disabled until the brief has text', async ({ page }) => {
    await page.goto('/projects/new')

    const button = page.getByRole('button', { name: 'Build workbench' })
    await expect(button).toBeDisabled()

    await page.getByPlaceholder(/describe your idea/i).fill('A quick idea')
    await expect(button).toBeEnabled()
  })

  test('warns, but does not block, when the brief requests more shots than the selected duration caps', async ({
    page,
  }) => {
    const user = primary.user
    {
      // DEFAULT_DURATION_TARGET ('30-60s') is pre-selected, targetShots = 8.
      await page.route('**/api/projects/*/shots', (route) => route.abort())
      await page.goto('/projects/new')

      const warning = page.getByTestId('shot-count-warning')
      await expect(warning).toBeHidden()

      const brief = 'Create a 12 shot video about the history of the Great Wall of China'
      await page.getByPlaceholder(/describe your idea/i).fill(brief)
      await expect(warning).toBeVisible()

      const button = page.getByRole('button', { name: 'Build workbench' })
      await expect(button).toBeEnabled()

      // The warning never blocks the real submission path, not just the button state.
      await button.click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/workbench$/, { waitUntil: 'commit' })

      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/workbench$/)?.[1]
      expect(projectId).toBeTruthy()

      const { data: project, error } = await admin
        .from('projects')
        .select('user_id, source_text')
        .eq('id', projectId!)
        .single()
      expect(error).toBeNull()
      expect(project!.user_id).toBe(user.id)
      expect(project!.source_text).toBe(brief)
    }
  })

  test('does not warn when the requested shot count is at or below the selected duration cap', async ({ page }) => {
    await page.route('**/api/projects/*/shots', (route) => route.abort())
    await page.goto('/projects/new')

    const warning = page.getByTestId('shot-count-warning')

    // Below target (30-60s tier, targetShots = 8) - mirrors the already-correct
    // production behavior where fewer shots than target is honored, not padded.
    await page.getByPlaceholder(/describe your idea/i).fill('Create a 4 shot video about a lighthouse')
    await expect(warning).toBeHidden()

    // Exactly at target - explicit boundary, must stay silent.
    await page.getByPlaceholder(/describe your idea/i).fill('Create an 8 shot video about a lighthouse')
    await expect(warning).toBeHidden()
  })

  test('rail and empty-state "New Project" links navigate to the intake screen', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await context.addCookies([cookie])
      await page.goto('/dashboard')

      await page.getByTestId('new-project-empty').click()
      await page.waitForURL('/projects/new', { waitUntil: 'commit' })
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test.describe('Quality', () => {
    const estimateOf = async (page: import('@playwright/test').Page, id: string) =>
      Number((await page.getByTestId(id).innerText()).replace(/[^0-9]/g, ''))

    test('defaults to Low, and the estimates follow the duration and ascend Low < Medium < High', async ({ page }) => {
      await page.goto('/projects/new')
      await expect(page.getByTestId('quality-preset-low')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('quality-custom-label')).toBeHidden()

      const read = async () => [
        await estimateOf(page, 'quality-preset-low-estimate'),
        await estimateOf(page, 'quality-preset-medium-estimate'),
        await estimateOf(page, 'quality-preset-high-estimate'),
      ]
      const short = await read()
      expect(short[0]).toBeLessThan(short[1])
      expect(short[1]).toBeLessThan(short[2])
      // The line above the button shows the selected preset's figure.
      expect(await estimateOf(page, 'intake-estimate')).toBe(short[0])

      // Retried: a click that lands before hydration is lost.
      await expect(async () => {
        await page.getByText('3–5 min', { exact: true }).click()
        expect(await estimateOf(page, 'quality-preset-low-estimate')).toBeGreaterThan(short[0])
      }).toPass({ timeout: 10_000 })
      const long = await read()
      long.forEach((figure, i) => expect(figure).toBeGreaterThan(short[i]))
      expect(long[0]).toBeLessThan(long[1])
      expect(long[1]).toBeLessThan(long[2])
      expect(await estimateOf(page, 'intake-estimate')).toBe(long[0])
    })

    test('Advanced makes it Custom, disables unsupported resolutions, drops resolution with a notice, and saves the five columns', async ({
      page,
    }) => {
      await page.route('**/api/projects/*/shots', (route) => route.abort())
      await page.goto('/projects/new')
      await page.getByPlaceholder(/describe your idea/i).fill('A quiet film about tides.')

      await page.getByRole('button', { name: 'Advanced' }).click()
      await expect(page.getByTestId('quality-custom-label')).toBeVisible()
      await expect(page.getByTestId('quality-preset-low')).toHaveAttribute('aria-checked', 'false')

      // Wan 3.0 at 1080p, then Seedance 2.0 Mini - which tops out at 720p.
      await page.getByTestId('quality-resolution-1080p').click()
      await expect(page.getByTestId('quality-resolution-1080p')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('quality-model-seedance-2.0-mini')).toHaveAttribute('data-supported', 'false')
      await expect(page.getByTestId('quality-model-seedance-2.0-mini-rate')).toHaveText('— at 1080p')
      await page.getByTestId('quality-model-seedance-2.0-mini').click()
      await expect(page.getByTestId('quality-resolution-720p')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('quality-resolution-notice')).toHaveText(
        'Resolution set to 720p. Seedance 2.0 Mini supports up to 720p.'
      )
      const unsupported = page.getByTestId('quality-resolution-1080p')
      await expect(unsupported).toHaveAttribute('aria-disabled', 'true')
      await expect(unsupported).toHaveAttribute('title', 'Seedance 2.0 Mini supports up to 720p')
      await unsupported.click({ force: true })
      await expect(page.getByTestId('quality-resolution-720p')).toHaveAttribute('aria-checked', 'true')

      await page.getByTestId('quality-image-high').click()
      await page.getByTestId('quality-image-model-gpt-image-2').click()
      await expect(page.getByTestId('quality-image-model-gpt-image-2')).toHaveAttribute('aria-checked', 'true')

      await page.getByRole('button', { name: 'Build workbench' }).click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/workbench$/, { waitUntil: 'commit' })
      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/workbench$/)![1]
      const { data: project } = await admin
        .from('projects')
        .select('quality_preset, video_model, video_resolution, image_quality, image_model')
        .eq('id', projectId)
        .single()
      expect(project).toEqual({
        quality_preset: 'custom',
        video_model: 'seedance-2.0-mini',
        video_resolution: '720p',
        image_quality: 'high',
        image_model: 'gpt-image-2',
      })
    })

    test('a template copies all five quality values', async ({ page, context }) => {
      // A fresh user, so the template is certainly in this user's recent-projects list.
      const { user, cookie } = await createTestSession()
      try {
        await context.addCookies([cookie])
        const { error } = await admin.from('projects').insert({
          user_id: user.id,
          title: 'Quality template',
          source_text: 'Template brief.',
          duration_target: '1-2min',
          quality_preset: 'custom',
          video_model: 'wan-2.5',
          video_resolution: '1080p',
          image_quality: 'medium',
          image_model: 'gpt-image-2',
        })
        expect(error).toBeNull()

        await page.route('**/api/projects/*/shots', (route) => route.abort())
        await page.goto('/projects/new')
        await page.getByRole('radio', { name: 'Quality template' }).click()
        await expect(page.getByTestId('quality-custom-label')).toBeVisible()
        await expect(page.getByTestId('quality-model-wan-2.5')).toHaveAttribute('aria-checked', 'true')

        await page.getByPlaceholder(/describe your idea/i).fill('A new film from the template.')
        await page.getByRole('button', { name: 'Build workbench' }).click()
        await page.waitForURL(/\/projects\/[0-9a-f-]+\/workbench$/, { waitUntil: 'commit' })
        const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/workbench$/)![1]
        const { data: project } = await admin
          .from('projects')
          .select('quality_preset, video_model, video_resolution, image_quality, image_model')
          .eq('id', projectId)
          .single()
        expect(project).toEqual({
          quality_preset: 'custom',
          video_model: 'wan-2.5',
          video_resolution: '1080p',
          image_quality: 'medium',
          image_model: 'gpt-image-2',
        })
      } finally {
        await deleteTestUser(user.id)
      }
    })
  })
})

test.describe('New Project intake - the balance check', () => {
  test('a balance short of the shot list shows the needed amount and the balance, disables Build, and still lets the project be created without writing shots', async ({ page, context }) => {
    const { user, cookie } = await createTestSession()
    try {
      // 10 credits: short of the 30-60s shot list's 2 x 8 = 16.
      const { error } = await admin.from('credit_ledger').insert([
        { user_id: user.id, kind: 'signup_grant', delta: 5000, dedupe_key: `signup_grant:${user.id}`, price_version: 'test' },
        {
          user_id: user.id,
          kind: 'spend',
          delta: -4990,
          step: 'workbench',
          operation: 'agent_turn',
          attempt_id: crypto.randomUUID(),
          pricing_mode: 'dynamic',
          dedupe_key: `agent_turn:${crypto.randomUUID()}`,
          price_version: 'test',
        },
      ])
      expect(error).toBeNull()
      await context.addCookies([cookie])
      await page.route('**/api/projects/*/shots', (route) => route.abort())
      await page.goto('/projects/new')

      const shortfall = page.getByTestId('intake-shortfall')
      await expect(shortfall).toContainText('Writing the shot list needs 16 credits')
      await expect(shortfall).toContainText('10 left')
      await expect(shortfall.getByRole('link', { name: 'Add credits' })).toHaveAttribute('href', '/credits')
      // The whole video's estimate stays shown, labelled as one - it gates nothing.
      await expect(page.getByTestId('intake-estimate')).toContainText('Estimated')

      await page.getByPlaceholder(/describe your idea/i).fill('A short video about lighthouses')
      await expect(page.getByRole('button', { name: 'Build workbench' })).toBeDisabled()
      await page.getByRole('button', { name: 'Create the project without writing shots' }).click()
      await page.waitForURL(/\/projects\/[0-9a-f-]+\/workbench$/, { waitUntil: 'commit' })
      const projectId = page.url().match(/\/projects\/([0-9a-f-]+)\/workbench$/)?.[1]
      const { data: project } = await admin.from('projects').select('user_id, source_text').eq('id', projectId!).single()
      expect(project).toEqual({ user_id: user.id, source_text: 'A short video about lighthouses' })
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('with enough credits the estimate line shows the balance left and no shortfall', async ({ page }) => {
    await page.goto('/projects/new')
    await expect(page.getByTestId('intake-balance')).toBeVisible()
    await expect(page.getByTestId('intake-shortfall')).toHaveCount(0)
  })
})
