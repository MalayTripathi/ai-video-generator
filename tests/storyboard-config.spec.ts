import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { modelsConfig } from '../src/lib/config/models'
import { STEP_OPERATIONS, stepOperationLabel } from '../src/lib/config/pipeline'
import { runImagesRequest } from '../src/app/api/projects/[id]/images/logic'

// modelsConfig is evaluated once at import, so each env scenario loads models.ts fresh in
// its own child process (models.ts has no imports, so plain Node type-stripping runs it).
const MODELS_URL = 'file://' + path.resolve(__dirname, '../src/lib/config/models.ts')

function loadStoryboardConfig(env: Record<string, string>): Promise<{ ok: boolean; value?: unknown; message?: string }> {
  const script = `
    import(${JSON.stringify(MODELS_URL)}).then(
      (m) => process.stdout.write(JSON.stringify({ ok: true, value: m.modelsConfig.storyboardImages })),
      (err) => process.stdout.write(JSON.stringify({ ok: false, message: err.message }))
    )
  `
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  for (const key of [
    'STORYBOARD_IMAGE_PROVIDER',
    'OPENAI_STORYBOARD_IMAGE_MODEL',
    'OPENAI_STORYBOARD_IMAGE_QUALITY',
    'FALAI_STORYBOARD_IMAGE_MODEL',
  ]) {
    if (!(key in env)) delete childEnv[key]
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env: childEnv as NodeJS.ProcessEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`models child exited ${code}: ${stderr}`))
      resolve(JSON.parse(stdout.trim()))
    })
  })
}

test.describe('storyboard image config', () => {
  test('defaults: openai, gpt-image-2.5-flare, low', async () => {
    const result = await loadStoryboardConfig({})
    expect(result).toEqual({ ok: true, value: { provider: 'openai', model: 'gpt-image-2.5-flare', quality: 'low' } })
  })

  test('the model is swapped by env alone (Sunburst), independent of the element model', async () => {
    const result = await loadStoryboardConfig({
      OPENAI_STORYBOARD_IMAGE_MODEL: 'gpt-image-2.5-sunburst',
      OPENAI_ELEMENT_IMAGE_MODEL: 'gpt-image-1-mini',
    })
    expect(result.ok && (result.value as { model: string }).model).toBe('gpt-image-2.5-sunburst')
  })

  test('fal provider reads its own model variable', async () => {
    const result = await loadStoryboardConfig({
      STORYBOARD_IMAGE_PROVIDER: 'fal',
      FALAI_STORYBOARD_IMAGE_MODEL: 'some-fal-model',
    })
    expect(result).toEqual({ ok: true, value: { provider: 'fal', model: 'some-fal-model', quality: 'low' } })
  })

  test('a quality other than low refuses to start - the price is calibrated for low only', async () => {
    const result = await loadStoryboardConfig({ OPENAI_STORYBOARD_IMAGE_QUALITY: 'medium' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('OPENAI_STORYBOARD_IMAGE_QUALITY')
  })

  test('with fal selected, the images route refuses before touching the database', async () => {
    const original = modelsConfig.storyboardImages.provider
    modelsConfig.storyboardImages.provider = 'fal'
    try {
      const untouchable = new Proxy(
        {},
        {
          get() {
            throw new Error('the database was touched')
          },
        }
      ) as Parameters<typeof runImagesRequest>[0]['supabase']
      const result = await runImagesRequest({
        supabase: untouchable,
        projectId: 'p',
        userId: 'u',
        shotIds: ['s'],
        getBalance: async () => {
          throw new Error('balance was read')
        },
        ensureSignupGrant: async () => {
          throw new Error('grant was touched')
        },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(500)
    } finally {
      modelsConfig.storyboardImages.provider = original
    }
  })
})

test.describe('pipeline vocabulary', () => {
  test('image generation belongs to the storyboard step only', () => {
    expect(STEP_OPERATIONS.image_prompts).not.toContain('generate_image')
    expect(STEP_OPERATIONS.storyboard).toContain('generate_image')
    expect(stepOperationLabel('storyboard', 'generate_image')).toBe('Storyboard — Image generation')
  })
})
