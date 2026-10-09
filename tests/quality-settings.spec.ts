import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { DEFAULT_DURATION_TARGET, durationConfig, parseDurationTarget, type DurationTarget } from '../src/lib/config/duration'
import { VIDEO_RESOLUTIONS, type AspectRatio } from '../src/lib/config/enums'
import { QUALITY_PRESETS, VIDEO_MODEL_IDS } from '../src/lib/config/models'
import { CREDIT_MARGIN, usdToCredits } from '../src/lib/config/credits'
import { videoUsdPerSecond } from '../src/lib/config/pricing'
import {
  estimateCredits,
  frameCredits,
  parseQualitySettings,
  presetSettings,
  supportsResolution,
  tierBadges,
  UnsupportedQualityError,
} from '../src/lib/quality/estimate'
import { applyProjectSettings, previewSettingsTrims } from '../src/lib/projects/settings'

const TIERS = Object.keys(durationConfig) as DurationTarget[]
const PRESETS = Object.keys(QUALITY_PRESETS) as (keyof typeof QUALITY_PRESETS)[]

test.describe('quality helper', () => {
  test('tier badges rank only the models that support the resolution, in thirds by rate', () => {
    for (const res of VIDEO_RESOLUTIONS) {
      const badges = tierBadges(res)
      const supporting = VIDEO_MODEL_IDS.filter((id) => supportsResolution(id, res))
      // Unsupported models get no badge at all.
      expect(Object.keys(badges).sort()).toEqual([...supporting].sort())

      const ranked = [...supporting].sort(
        (a, b) => videoUsdPerSecond({ model: a, resolution: res, audio: false }) - videoUsdPerSecond({ model: b, resolution: res, audio: false })
      )
      ranked.forEach((id, i) => {
        const third = Math.floor((i * 3) / ranked.length)
        expect(badges[id]).toBe(['Budget', 'Standard', 'Premium'][third])
      })
    }
    // At 1080p the two Seedance 2.0 models (480p-720p only) are out of the ranking.
    expect(tierBadges('1080p')['seedance-2.0-mini']).toBeUndefined()
    expect(tierBadges('1080p')['seedance-2.0-fast']).toBeUndefined()
  })

  test('the estimate is target shots x frame credits plus max seconds x the clip rate, for every preset and tier', () => {
    const aspect: AspectRatio = '9:16'
    for (const tier of TIERS) {
      const config = durationConfig[tier]
      const figures = PRESETS.map((id) => {
        const preset = presetSettings(id)
        const usd = videoUsdPerSecond({ model: preset.videoModel, resolution: preset.videoResolution, audio: false })
        const expected =
          config.targetShots * frameCredits(preset.imageQuality, aspect) +
          usdToCredits(usd * config.targetSecondsMax * CREDIT_MARGIN)
        const actual = estimateCredits({ durationTarget: tier, aspectRatio: aspect, ...preset })
        expect(actual).toBe(expected)
        return actual
      })
      // Low < Medium < High at every duration tier.
      expect(figures[0]).toBeLessThan(figures[1])
      expect(figures[1]).toBeLessThan(figures[2])
    }
  })

  test('the server validator rejects combinations the registry does not support', () => {
    const reject = (raw: Parameters<typeof parseQualitySettings>[0]) =>
      expect(() => parseQualitySettings(raw)).toThrow(UnsupportedQualityError)
    reject({ preset: 'custom', videoModel: 'seedance-2.0-mini', videoResolution: '1080p', imageQuality: 'low' })
    reject({ preset: 'custom', videoModel: 'not-a-model', videoResolution: '720p', imageQuality: 'low' })
    reject({ preset: 'custom', videoModel: 'wan-3.0', videoResolution: '4k', imageQuality: 'low' })
    reject({ preset: 'custom', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'ultra' })
    reject({ preset: 'turbo', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'low' })
    // A named preset must carry exactly its own values.
    reject({ preset: 'low', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'low' })
    reject({ preset: null, videoModel: null, videoResolution: null, imageQuality: null })

    expect(parseQualitySettings({ preset: 'custom', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'high' })).toEqual({
      preset: 'custom',
      videoModel: 'wan-3.0',
      videoResolution: '720p',
      imageQuality: 'high',
    })
    expect(parseQualitySettings({ preset: 'low', ...QUALITY_PRESETS.low })).toEqual(presetSettings('low'))
  })

  test('a missing or unknown duration falls back to the intake default', () => {
    expect(parseDurationTarget(null)).toBe(DEFAULT_DURATION_TARGET)
    expect(parseDurationTarget('')).toBe(DEFAULT_DURATION_TARGET)
    expect(parseDurationTarget('forever')).toBe(DEFAULT_DURATION_TARGET)
    expect(parseDurationTarget('toString')).toBe(DEFAULT_DURATION_TARGET)
    expect(parseDurationTarget('3-5min')).toBe('3-5min')
  })
})

// --- Apply, against the project's own rows ---

const KEY_ALPHABET = '23456789bcdfghjkmnpqrstvwxz'

async function seedProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Quality settings test',
      source_text: 'A short film for settings tests.',
      duration_target: '30-60s',
      current_step: 'video_prompts',
      furthest_step: 5,
      quality_preset: 'low',
      video_model: 'wan-3.0',
      video_resolution: '480p',
      image_quality: 'low',
      ...overrides,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShots(projectId: string, shots: { seconds: number; film?: number | null; binned?: boolean; prompt?: boolean }[]) {
  const rows = shots.map((shot, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: `bbbb${KEY_ALPHABET[i]}`,
    voice_over: `Line ${i + 1}.`,
    duration_sec: shot.seconds,
    film_duration_sec: shot.film ?? null,
    binned_at: shot.binned ? new Date().toISOString() : null,
    video_prompt: shot.prompt ? 'A slow push in.' : null,
  }))
  const { data, error } = await admin.from('shots').insert(rows).select('id, order_index').order('order_index')
  expect(error).toBeNull()
  return data!.map((row) => row.id as string)
}

async function addDialogue(projectId: string, shotId: string) {
  const { data: character, error } = await admin
    .from('elements')
    .insert({ project_id: projectId, name: `Speaker ${shotId.slice(0, 6)}`, type: 'character' })
    .select('id')
    .single()
  expect(error).toBeNull()
  const { error: lineError } = await admin
    .from('shot_dialogue')
    .insert({ project_id: projectId, shot_id: shotId, element_id: character!.id, line: 'Hello.', order_index: 0 })
  expect(lineError).toBeNull()
}

async function readProject(projectId: string) {
  const { data } = await admin
    .from('projects')
    .select('quality_preset, video_model, video_resolution, image_quality, current_step, furthest_step')
    .eq('id', projectId)
    .single()
  return data!
}

async function readShots(projectId: string) {
  const { data } = await admin
    .from('shots')
    .select('id, duration_sec, film_duration_sec, video_prompt_stale')
    .eq('project_id', projectId)
    .order('order_index')
  return data!
}

const KLING_720 = { preset: 'custom', videoModel: 'kling-v3-standard', videoResolution: '720p', imageQuality: 'low' }

test.describe('project settings apply', () => {
  test('preview lists in-film shots over the new maximum and flags the ones with dialogue', async () => {
    const projectId = await seedProject()
    // Kling's maximum is 15s. Shot 2 is over by film length, shot 4 is binned.
    const ids = await seedShots(projectId, [
      { seconds: 8 },
      { seconds: 12, film: 22 },
      { seconds: 18 },
      { seconds: 24, binned: true },
      { seconds: 15 },
    ])
    await addDialogue(projectId, ids[2])

    const trims = await previewSettingsTrims(admin, primary.user.id, projectId, 'kling-v3-standard')
    expect(trims).toEqual([
      { shotId: ids[1], number: 2, fromSeconds: 22, toSeconds: 15, hasDialogue: false },
      { shotId: ids[2], number: 3, fromSeconds: 18, toSeconds: 15, hasDialogue: true },
    ])

    // A model with a higher maximum trims nothing.
    const higher = await previewSettingsTrims(admin, primary.user.id, projectId, 'wan-3.0')
    expect(higher).toEqual([])
  })

  test('apply trims both duration fields, marks video prompts stale and never advances the step', async () => {
    const projectId = await seedProject()
    const ids = await seedShots(projectId, [
      { seconds: 8, prompt: true },
      { seconds: 12, film: 22, prompt: true },
      { seconds: 18 },
      { seconds: 24, binned: true },
    ])

    const result = await applyProjectSettings(admin, primary.user.id, projectId, KLING_720, 2)
    expect(result).toEqual({ ok: true, trimmed: 2 })

    const shots = await readShots(projectId)
    const byId = new Map(shots.map((shot) => [shot.id, shot]))
    expect(byId.get(ids[0])).toMatchObject({ duration_sec: 8, film_duration_sec: null })
    expect(byId.get(ids[1])).toMatchObject({ duration_sec: 15, film_duration_sec: 15 })
    expect(byId.get(ids[2])).toMatchObject({ duration_sec: 15, film_duration_sec: 15 })
    // The binned shot is not in the film, so it is not trimmed.
    expect(byId.get(ids[3])).toMatchObject({ duration_sec: 24, film_duration_sec: null })
    expect(shots.every((shot) => shot.video_prompt_stale)).toBe(true)

    expect(await readProject(projectId)).toEqual({
      quality_preset: 'custom',
      video_model: 'kling-v3-standard',
      video_resolution: '720p',
      image_quality: 'low',
      current_step: 'video_prompts',
      furthest_step: 5,
    })
  })

  test('a resolution or image-quality change alone trims nothing and marks nothing stale', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, [{ seconds: 28 }])

    const result = await applyProjectSettings(
      admin,
      primary.user.id,
      projectId,
      { preset: 'custom', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'high' },
      0
    )
    expect(result).toEqual({ ok: true, trimmed: 0 })
    const [shot] = await readShots(projectId)
    expect(shot).toMatchObject({ duration_sec: 28, video_prompt_stale: false })
    expect(await readProject(projectId)).toMatchObject({ video_resolution: '720p', image_quality: 'high', quality_preset: 'custom' })
  })

  test('when the over-length shots differ from what was confirmed, nothing is written', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, [{ seconds: 20 }, { seconds: 25 }])

    const result = await applyProjectSettings(admin, primary.user.id, projectId, KLING_720, 1)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe('trims_changed')

    const shots = await readShots(projectId)
    expect(shots.map((shot) => shot.duration_sec)).toEqual([20, 25])
    expect(shots.every((shot) => !shot.video_prompt_stale)).toBe(true)
    expect(await readProject(projectId)).toMatchObject({ video_model: 'wan-3.0', quality_preset: 'low' })
  })

  test('an unsupported combination is rejected before any write', async () => {
    const projectId = await seedProject()
    const result = await applyProjectSettings(
      admin,
      primary.user.id,
      projectId,
      { preset: 'custom', videoModel: 'seedance-2.0-mini', videoResolution: '1080p', imageQuality: 'low' },
      0
    )
    expect(result).toMatchObject({ ok: false, error: 'unsupported' })
    expect(await readProject(projectId)).toMatchObject({ video_model: 'wan-3.0', video_resolution: '480p' })
  })

  test('after generation starts, video settings are refused and image quality still saves', async () => {
    const projectId = await seedProject({ current_step: 'generation', furthest_step: 6 })
    await seedShots(projectId, [{ seconds: 20 }])

    const modelChange = await applyProjectSettings(admin, primary.user.id, projectId, { ...KLING_720 }, 1)
    expect(modelChange).toMatchObject({ ok: false, error: 'locked' })
    const resolutionChange = await applyProjectSettings(
      admin,
      primary.user.id,
      projectId,
      { preset: 'custom', videoModel: 'wan-3.0', videoResolution: '1080p', imageQuality: 'low' },
      0
    )
    expect(resolutionChange).toMatchObject({ ok: false, error: 'locked' })
    const presetChange = await applyProjectSettings(admin, primary.user.id, projectId, { preset: 'high', ...QUALITY_PRESETS.high }, 0)
    expect(presetChange).toMatchObject({ ok: false, error: 'locked' })
    expect(await readProject(projectId)).toMatchObject({ video_model: 'wan-3.0', video_resolution: '480p', quality_preset: 'low' })

    const imageChange = await applyProjectSettings(
      admin,
      primary.user.id,
      projectId,
      { preset: 'custom', videoModel: 'wan-3.0', videoResolution: '480p', imageQuality: 'high' },
      0
    )
    expect(imageChange).toEqual({ ok: true, trimmed: 0 })
    expect(await readProject(projectId)).toMatchObject({ image_quality: 'high', quality_preset: 'custom', video_model: 'wan-3.0' })
  })

  test("another user's project is not found and is left untouched", async () => {
    const projectId = await seedProject()
    const result = await applyProjectSettings(admin, '00000000-0000-0000-0000-000000000000', projectId, KLING_720, 0)
    expect(result).toMatchObject({ ok: false, error: 'not_found' })
    expect(await readProject(projectId)).toMatchObject({ video_model: 'wan-3.0' })
  })
})
