import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { IMAGE_MODELS } from '../src/lib/config/models'
import { OPENAI_RATES } from '../src/lib/config/pricing'
import { STEP_OPERATIONS, stepOperationLabel } from '../src/lib/config/pipeline'

// modelsConfig (and isProduction) are evaluated once at import, so each env scenario loads
// models.ts fresh in its own child process - through the repo's alias loader, since
// models.ts imports its enums by an extensionless path plain Node can't resolve.
const MODELS_URL = 'file://' + path.resolve(__dirname, '../src/lib/config/models.ts')
const ALIAS_LOADER_URL = 'file://' + path.resolve(__dirname, 'helpers/ts-alias-loader.mjs')

// The image-model env vars this module used to read. Deleted from every child below, and
// set to junk in one, to prove nothing reads them any more.
const RETIRED_IMAGE_ENV_KEYS = [
  'ELEMENT_IMAGE_PROVIDER',
  'STORYBOARD_IMAGE_PROVIDER',
  'OPENAI_ELEMENT_IMAGE_MODEL',
  'OPENAI_STORYBOARD_IMAGE_MODEL',
  'FALAI_ELEMENT_IMAGE_MODEL',
  'FALAI_STORYBOARD_IMAGE_MODEL',
]
const CONFIG_ENV_KEYS = [...RETIRED_IMAGE_ENV_KEYS, 'IMAGE_QUALITY_DEV_CAP']

/** Evaluates `expression` (with `m` = the models module) in a fresh child, under `env`. */
function inModels(expression: string, env: Record<string, string>): Promise<{ ok: boolean; value?: unknown; message?: string }> {
  const script = `
    require('node:module').register(${JSON.stringify(ALIAS_LOADER_URL)})
    import(${JSON.stringify(MODELS_URL)}).then(
      (m) => process.stdout.write(JSON.stringify({ ok: true, value: ${expression} })),
      (err) => process.stdout.write(JSON.stringify({ ok: false, message: err.message }))
    ).catch((err) => process.stdout.write(JSON.stringify({ ok: false, message: err.message })))
  `
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  for (const key of CONFIG_ENV_KEYS) {
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

// Every model x use x quality, resolved inside the child: "model:use:quality" -> "model/provider".
const RESOLVE_ALL = `Object.fromEntries(['gpt-image-2.5-flare', 'gpt-image-2'].flatMap((model) =>
  ['element_reference', 'storyboard_frame'].flatMap((use) =>
    ['low', 'medium', 'high'].map((q) => { const r = m.resolveImageModel(model, use, q); return [model + ':' + use + ':' + q, r.id + '/' + r.provider] }))))`

test.describe('image model registry', () => {
  test("every use and quality resolves to the project's own model and its provider, with no image env set", async () => {
    const result = await inModels(RESOLVE_ALL, {})
    expect(result.ok).toBe(true)
    const resolved = result.value as Record<string, string>
    expect(Object.keys(resolved)).toHaveLength(12)
    for (const [key, value] of Object.entries(resolved)) expect(value).toBe(`${key.split(':')[0]}/openai`)
  })

  test('an unregistered model, or a quality a model does not offer, is refused', async () => {
    expect(await inModels("m.resolveImageModel('dall-e-3', 'storyboard_frame', 'low')", {})).toMatchObject({ ok: false })
    expect(await inModels("m.resolveImageModel('gpt-image-2', 'storyboard_frame', 'max')", {})).toMatchObject({ ok: false })
  })

  test('the retired image env vars are never read - setting them changes nothing', async () => {
    const junk = Object.fromEntries(RETIRED_IMAGE_ENV_KEYS.map((key) => [key, key.includes('PROVIDER') ? 'fal' : 'gpt-image-1-mini']))
    expect(await inModels(RESOLVE_ALL, junk)).toEqual(await inModels(RESOLVE_ALL, {}))
    const config = await inModels('m.modelsConfig.elements', junk)
    expect(config).toEqual({ ok: true, value: { size: '1024x1024' } })
  })

  test('each registered model carries its provider, its uses and its qualities, and has rates', async () => {
    const result = await inModels(
      "Object.values(m.IMAGE_MODELS).map((x) => ({ id: x.id, provider: x.provider, uses: x.uses, qualities: x.qualities, deprecatedOn: x.deprecatedOn, source: x.source }))",
      {}
    )
    const entry = (id: string) => ({
      id,
      provider: 'openai',
      uses: ['element_reference', 'storyboard_frame'],
      qualities: ['low', 'medium', 'high'],
      deprecatedOn: null,
      source: expect.arrayContaining([expect.stringMatching(/^https:\/\//)]),
    })
    expect(result).toEqual({ ok: true, value: [entry('gpt-image-2.5-flare'), entry('gpt-image-2')] })
    expect(Object.keys(OPENAI_RATES.images).sort()).toEqual(Object.keys(IMAGE_MODELS).sort())
  })
})

test.describe('image quality dev cap', () => {
  const sent = (env: Record<string, string>) =>
    inModels("['low', 'medium', 'high'].map((q) => m.effectiveImageQuality(q))", env)

  test('unset, every project quality is sent as asked', async () => {
    expect(await sent({ NODE_ENV: 'development' })).toEqual({ ok: true, value: ['low', 'medium', 'high'] })
  })

  test('outside production it lowers the quality sent, never raises it', async () => {
    expect(await sent({ NODE_ENV: 'development', IMAGE_QUALITY_DEV_CAP: 'medium' })).toEqual({
      ok: true,
      value: ['low', 'medium', 'medium'],
    })
    expect(await sent({ NODE_ENV: 'development', IMAGE_QUALITY_DEV_CAP: 'low' })).toEqual({
      ok: true,
      value: ['low', 'low', 'low'],
    })
  })

  test('it never applies in production', async () => {
    expect(await sent({ NODE_ENV: 'production', IMAGE_QUALITY_DEV_CAP: 'low' })).toEqual({
      ok: true,
      value: ['low', 'medium', 'high'],
    })
  })

  test('an unrecognised cap fails loudly instead of being ignored', async () => {
    const result = await sent({ NODE_ENV: 'development', IMAGE_QUALITY_DEV_CAP: 'ultra' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('IMAGE_QUALITY_DEV_CAP')
  })
})

test.describe('pipeline vocabulary', () => {
  test('image generation belongs to the storyboard step only', () => {
    expect(STEP_OPERATIONS.image_prompts).not.toContain('generate_image')
    expect(STEP_OPERATIONS.storyboard).toContain('generate_image')
    expect(stepOperationLabel('storyboard', 'generate_image')).toBe('Storyboard — Image generation')
  })
})
