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
import { applyProjectSettings, previewSettingsLengthChanges } from '../src/lib/projects/settings'

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
          config.targetShots * frameCredits(preset.imageModel, preset.imageQuality, aspect) +
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
    reject({ preset: 'custom', videoModel: 'seedance-2.0-mini', videoResolution: '1080p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' })
    reject({ preset: 'custom', videoModel: 'not-a-model', videoResolution: '720p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' })
    reject({ preset: 'custom', videoModel: 'wan-3.0', videoResolution: '4k', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' })
    reject({ preset: 'custom', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'ultra', imageModel: 'gpt-image-2.5-flare' })
    reject({ preset: 'turbo', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' })
    // A named preset must carry exactly its own values.
    reject({ preset: 'low', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' })
    reject({ preset: null, videoModel: null, videoResolution: null, imageQuality: null, imageModel: null })
    reject({ preset: 'custom', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'low', imageModel: 'dall-e-3' })
    // Presets all draw on the default image model - GPT Image 2 is an Advanced (custom) choice.
    reject({ preset: 'low', ...QUALITY_PRESETS.low, imageModel: 'gpt-image-2' })

    expect(
      parseQualitySettings({ preset: 'custom', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'high', imageModel: 'gpt-image-2' })
    ).toEqual({
      preset: 'custom',
      videoModel: 'wan-3.0',
      videoResolution: '720p',
      imageQuality: 'high',
      imageModel: 'gpt-image-2',
    })
    expect(parseQualitySettings({ preset: 'low', ...QUALITY_PRESETS.low })).toEqual(presetSettings('low'))
  })

  test('GPT Image 2 frames cost at least as much as 2.5-flare at every quality, and the estimate follows the image model', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      expect(frameCredits('gpt-image-2', quality, '9:16')).toBeGreaterThanOrEqual(frameCredits('gpt-image-2.5-flare', quality, '9:16'))
      expect(frameCredits('gpt-image-2', quality, '9:16', 1)).toBeGreaterThan(frameCredits('gpt-image-2', quality, '9:16'))
    }
    const base = { durationTarget: '30-60s' as const, aspectRatio: '9:16' as const, videoModel: 'wan-3.0' as const, videoResolution: '480p' as const, imageQuality: 'high' as const }
    const flare = estimateCredits({ ...base, imageModel: 'gpt-image-2.5-flare' })
    const two = estimateCredits({ ...base, imageModel: 'gpt-image-2' })
    expect(two - flare).toBe(8 * (frameCredits('gpt-image-2', 'high', '9:16') - frameCredits('gpt-image-2.5-flare', 'high', '9:16')))
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

async function seedShots(
  projectId: string,
  shots: { seconds: number; film?: number | null; binned?: boolean; prompt?: boolean; voice?: string }[]
) {
  const rows = shots.map((shot, i) => ({
    project_id: projectId,
    order_index: i,
    shot_key: `bbbb${KEY_ALPHABET[i]}`,
    voice_over: shot.voice ?? `Line ${i + 1}.`,
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
    .select('quality_preset, video_model, video_resolution, image_quality, image_model, current_step, furthest_step')
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

const KLING_720 = { preset: 'custom', videoModel: 'kling-v3-standard', videoResolution: '720p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' }

test.describe('project settings apply - every new length is one the new model can make', () => {
  test("Wan 2.5's fixed 5s/10s: each shot snaps to the length nearest it that still covers its voice; one whose voice fits neither takes 10s, flagged", async () => {
    const projectId = await seedProject()
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
    const ids = await seedShots(projectId, [
      { seconds: 7, voice: words(4) }, // needs 2.1s: 5 and 10 cover it, 5 is nearer
      { seconds: 9, voice: words(20) }, // needs 9.5s: only 10 covers it
      { seconds: 6, voice: words(30) }, // needs 14.1s: nothing covers it
      { seconds: 10, voice: words(4) }, // already renderable - untouched
    ])
    const changes = await previewSettingsLengthChanges(admin, primary.user.id, projectId, 'wan-2.5')
    expect(changes!.map((c) => [c.number, c.toSeconds, c.overflow])).toEqual([
      [1, 5, false],
      [2, 10, false],
      [3, 10, true],
    ])
    const result = await applyProjectSettings(
      admin,
      primary.user.id,
      projectId,
      { preset: 'custom', videoModel: 'wan-2.5', videoResolution: '720p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' },
      3
    )
    expect(result).toEqual({ ok: true, trimmed: 3 })
    const { data } = await admin.from('shots').select('id, duration_sec, narration_overflow').eq('project_id', projectId).order('order_index')
    expect(data!.map((s) => [s.duration_sec, s.narration_overflow])).toEqual([
      [5, false],
      [10, false],
      [10, true],
      [10, false],
    ])
    expect(data![0].id).toBe(ids[0])
  })

  test('a model with a higher minimum (Seedance 2.0 Mini, 4-15s) lifts a 2s and a 3s shot to 4s', async () => {
    const projectId = await seedProject()
    await seedShots(projectId, [{ seconds: 2 }, { seconds: 3, film: 3 }, { seconds: 6 }])
    const changes = await previewSettingsLengthChanges(admin, primary.user.id, projectId, 'seedance-2.0-mini')
    expect(changes!.map((c) => [c.number, c.fromSeconds, c.toSeconds])).toEqual([
      [1, 2, 4],
      [2, 3, 4],
    ])
    const result = await applyProjectSettings(
      admin,
      primary.user.id,
      projectId,
      { preset: 'custom', videoModel: 'seedance-2.0-mini', videoResolution: '720p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' },
      2
    )
    expect(result).toEqual({ ok: true, trimmed: 2 })
    const shots = await readShots(projectId)
    expect(shots.map((s) => [s.duration_sec, s.film_duration_sec])).toEqual([
      [4, null],
      [4, 4],
      [6, null],
    ])
  })
})

test.describe('project settings apply', () => {
  test('preview lists every shot - in the film or binned - the new model cannot make at its length, and flags the ones with dialogue', async () => {
    const projectId = await seedProject()
    // Kling is 3-15s. Shot 2 is over by film length; shot 4 is binned, but could return to the film.
    const ids = await seedShots(projectId, [
      { seconds: 8 },
      { seconds: 12, film: 22 },
      { seconds: 18 },
      { seconds: 24, binned: true },
      { seconds: 15 },
    ])
    await addDialogue(projectId, ids[2])

    const changes = await previewSettingsLengthChanges(admin, primary.user.id, projectId, 'kling-v3-standard')
    expect(changes).toEqual([
      { shotId: ids[1], number: 2, fromSeconds: 22, toSeconds: 15, hasDialogue: false, overflow: false },
      { shotId: ids[2], number: 3, fromSeconds: 18, toSeconds: 15, hasDialogue: true, overflow: false },
      { shotId: ids[3], number: 4, fromSeconds: 24, toSeconds: 15, hasDialogue: false, overflow: false },
    ])

    // The project's own model changes nothing.
    expect(await previewSettingsLengthChanges(admin, primary.user.id, projectId, 'wan-3.0')).toEqual([])
  })

  test('apply gives both duration fields a renderable length in one write, marks video prompts stale and never advances the step', async () => {
    const projectId = await seedProject()
    const ids = await seedShots(projectId, [
      { seconds: 8, prompt: true },
      { seconds: 12, film: 22, prompt: true },
      { seconds: 18 },
      { seconds: 24, binned: true },
    ])

    const result = await applyProjectSettings(admin, primary.user.id, projectId, KLING_720, 3)
    expect(result).toEqual({ ok: true, trimmed: 3 })

    const shots = await readShots(projectId)
    const byId = new Map(shots.map((shot) => [shot.id, shot]))
    expect(byId.get(ids[0])).toMatchObject({ duration_sec: 8, film_duration_sec: null })
    // Only the field the model can't make changes: the script length 12 stays.
    expect(byId.get(ids[1])).toMatchObject({ duration_sec: 12, film_duration_sec: 15 })
    expect(byId.get(ids[2])).toMatchObject({ duration_sec: 15, film_duration_sec: null })
    // A binned shot can return to the film, so it gets a renderable length too.
    expect(byId.get(ids[3])).toMatchObject({ duration_sec: 15, film_duration_sec: null })
    expect(shots.every((shot) => shot.video_prompt_stale)).toBe(true)

    expect(await readProject(projectId)).toEqual({
      quality_preset: 'custom',
      video_model: 'kling-v3-standard',
      video_resolution: '720p',
      image_quality: 'low',
      image_model: 'gpt-image-2.5-flare',
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
      { preset: 'custom', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'high', imageModel: 'gpt-image-2.5-flare' },
      0
    )
    expect(result).toEqual({ ok: true, trimmed: 0 })
    const [shot] = await readShots(projectId)
    expect(shot).toMatchObject({ duration_sec: 28, video_prompt_stale: false })
    expect(await readProject(projectId)).toMatchObject({ video_resolution: '720p', image_quality: 'high', quality_preset: 'custom' })

    // The image model saves the same way, and regenerates nothing: shots are untouched.
    expect(
      await applyProjectSettings(
        admin,
        primary.user.id,
        projectId,
        { preset: 'custom', videoModel: 'wan-3.0', videoResolution: '720p', imageQuality: 'high', imageModel: 'gpt-image-2' },
        0
      )
    ).toEqual({ ok: true, trimmed: 0 })
    expect(await readProject(projectId)).toMatchObject({ image_model: 'gpt-image-2' })
    const [after] = await readShots(projectId)
    expect(after).toMatchObject({ duration_sec: 28, video_prompt_stale: false })
  })

  test('when the shots needing a new length differ from what was confirmed, nothing is written', async () => {
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
      { preset: 'custom', videoModel: 'seedance-2.0-mini', videoResolution: '1080p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' },
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
      { preset: 'custom', videoModel: 'wan-3.0', videoResolution: '1080p', imageQuality: 'low', imageModel: 'gpt-image-2.5-flare' },
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
      { preset: 'custom', videoModel: 'wan-3.0', videoResolution: '480p', imageQuality: 'high', imageModel: 'gpt-image-2' },
      0
    )
    expect(imageChange).toEqual({ ok: true, trimmed: 0 })
    expect(await readProject(projectId)).toMatchObject({
      image_quality: 'high',
      image_model: 'gpt-image-2',
      quality_preset: 'custom',
      video_model: 'wan-3.0',
    })
  })

  test('the backfill left every project on a registered image model - none is null', async () => {
    const { count, error } = await admin.from('projects').select('id', { count: 'exact', head: true }).is('image_model', null)
    expect(error).toBeNull()
    expect(count).toBe(0)
    const { count: unregistered } = await admin
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .not('image_model', 'in', '("gpt-image-2.5-flare","gpt-image-2")')
    expect(unregistered).toBe(0)
  })

  test("another user's project is not found and is left untouched", async () => {
    const projectId = await seedProject()
    const result = await applyProjectSettings(admin, '00000000-0000-0000-0000-000000000000', projectId, KLING_720, 0)
    expect(result).toMatchObject({ ok: false, error: 'not_found' })
    expect(await readProject(projectId)).toMatchObject({ video_model: 'wan-3.0' })
  })
})
