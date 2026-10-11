import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { throwingGateway } from './helpers/claude-fakes'
import { VIDEO_MODELS } from '../src/lib/config/models'
import { generateUniqueShotKeys } from '../src/lib/shot-key'
import {
  allowedModelDurations,
  nearestModelDuration,
  stepModelDuration,
  voiceCoveringDuration,
} from '../src/lib/shots/durations'
import { effectiveVideoModel } from '../src/lib/shots/effective-model'
import { isRetimeAllowed, nudgeRetime, retimeBounds, snapRetime, storyboardRetimeRange } from '../src/lib/storyboard/timeline'
import { saveFilmDurationForUser } from '../src/app/(app)/projects/[id]/storyboard/actions'
import { saveShotDurationForUser } from '../src/app/(app)/projects/[id]/workbench/actions'
import { handleInsertShot, handleUpdateShot, type AgentToolContext } from '../src/app/api/projects/[id]/agent/tools'

// Layer: api. Every path that sets a shot's length lands on one its video model can render:
// the Storyboard's drag and nudge (and its save), the Workbench stepper's save, the agent's
// update_shot and insert_shot - on Wan 2.5 (exactly 5s or 10s) and on a model with a higher
// minimum (Seedance 2.0 Mini, 4-15s). A model change is covered in quality-settings.spec.ts.

const WAN25 = VIDEO_MODELS['wan-2.5']
const MINI = VIDEO_MODELS['seedance-2.0-mini']

async function seedProject(videoModel: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Duration test',
      source_text: 'Durations.',
      video_type: 'auto',
      duration_target: '30-60s',
      video_model: videoModel,
      language: 'en',
      current_step: 'workbench',
      furthest_step: 2,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedShot(projectId: string, seconds: number, film: number | null = null) {
  const [key] = generateUniqueShotKeys(1)
  const { data, error } = await admin
    .from('shots')
    .insert({
      project_id: projectId,
      order_index: 0,
      shot_key: key,
      voice_over: 'Four words spoken here.',
      visual_description: 'A lighthouse.',
      duration_sec: seconds,
      film_duration_sec: film,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function readShot(shotId: string) {
  const { data } = await admin.from('shots').select('duration_sec, film_duration_sec').eq('id', shotId).single()
  return data!
}

const ctx = (projectId: string): AgentToolContext => ({
  supabase: admin,
  gateway: throwingGateway('no model call in a duration test'),
  projectId,
  userId: primary.user.id,
  furthestStepIndex: 2,
  messageId: crypto.randomUUID(),
})

test.describe('the renderable lengths', () => {
  test('allowed, nearest, next and voice-covering lengths on Wan 2.5 and Seedance 2.0 Mini', () => {
    expect(allowedModelDurations(WAN25)).toEqual([5, 10])
    expect(allowedModelDurations(MINI)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(nearestModelDuration(7.3, WAN25)).toBe(5)
    expect(nearestModelDuration(7.5, WAN25)).toBe(10) // a tie goes to the longer
    expect(nearestModelDuration(2, MINI)).toBe(4)
    expect(stepModelDuration(5, WAN25, 1)).toBe(10)
    expect(stepModelDuration(10, WAN25, 1)).toBe(10)
    expect(stepModelDuration(5, WAN25, -1)).toBe(5)
    expect(stepModelDuration(3, MINI, 1)).toBe(4)
    expect(voiceCoveringDuration(7, 2, WAN25)).toEqual({ seconds: 5, overflow: false })
    expect(voiceCoveringDuration(7, 6, WAN25)).toEqual({ seconds: 10, overflow: false })
    expect(voiceCoveringDuration(7, 12, WAN25)).toEqual({ seconds: 10, overflow: true })
    expect(voiceCoveringDuration(10, 2, WAN25)).toEqual({ seconds: 10, overflow: false })
    // Every shot's model is the project's until shots carry their own.
    expect(effectiveVideoModel({ video_model: 'wan-2.5' }, { id: 'x' })).toBe(WAN25)
  })
})

test.describe('Storyboard drag and nudge', () => {
  test('Wan 2.5: a drag snaps to 5s or 10s, a nudge steps between them, a save of any other length is refused', async () => {
    const range = storyboardRetimeRange('wan-2.5')
    const bounds = retimeBounds(7, range) // a shot saved at 7s (before the model changed)
    expect(snapRetime(6.2, bounds)).toBe(5)
    expect(snapRetime(8.4, bounds)).toBe(10)
    expect(snapRetime(30, bounds)).toBe(10)
    expect(nudgeRetime(5, 1, bounds)).toBe(10)
    expect(nudgeRetime(10, -1, bounds)).toBe(5)
    expect(nudgeRetime(7, 1, bounds)).toBe(10)
    expect(isRetimeAllowed(7.3, bounds)).toBe(false)
    expect(isRetimeAllowed(10, bounds)).toBe(true)

    const projectId = await seedProject('wan-2.5')
    const shotId = await seedShot(projectId, 5)
    expect(await saveFilmDurationForUser(admin, primary.user.id, projectId, shotId, 7)).toMatchObject({ success: false })
    expect(await saveFilmDurationForUser(admin, primary.user.id, projectId, shotId, 7.3)).toMatchObject({ success: false })
    expect(await saveFilmDurationForUser(admin, primary.user.id, projectId, shotId, 10)).toMatchObject({ success: true })
    expect((await readShot(shotId)).film_duration_sec).toBe(10)
  })

  test('a higher minimum (Seedance 2.0 Mini, 4s): a drag never goes under 4s, a nudge up from a 3s shot lands on 4s, whole seconds only', async () => {
    const range = storyboardRetimeRange('seedance-2.0-mini')
    const bounds = retimeBounds(3, range)
    expect(snapRetime(1.2, bounds)).toBe(4)
    expect(snapRetime(6.4, bounds)).toBe(6)
    expect(nudgeRetime(3, 1, bounds)).toBe(4)
    expect(nudgeRetime(4, -1, bounds)).toBe(4)

    const projectId = await seedProject('seedance-2.0-mini')
    const shotId = await seedShot(projectId, 6)
    expect(await saveFilmDurationForUser(admin, primary.user.id, projectId, shotId, 3)).toMatchObject({ success: false })
    expect(await saveFilmDurationForUser(admin, primary.user.id, projectId, shotId, 6.5)).toMatchObject({ success: false })
    expect(await saveFilmDurationForUser(admin, primary.user.id, projectId, shotId, 4)).toMatchObject({ success: true })
  })
})

test.describe("the Workbench stepper's save", () => {
  for (const [model, refused, accepted] of [
    ['wan-2.5', [7, 7.3, 0, Number.NaN], 10],
    ['seedance-2.0-mini', [2, 3, 4.5, 16], 4],
  ] as const) {
    test(`${model}: a length the model can't make is refused, never rounded into one; a valid one saves`, async () => {
      const projectId = await seedProject(model)
      const shotId = await seedShot(projectId, model === 'wan-2.5' ? 5 : 6)
      for (const value of refused) {
        expect(await saveShotDurationForUser(admin, primary.user.id, shotId, value)).toMatchObject({ field: 'duration_sec', success: false })
      }
      expect((await readShot(shotId)).duration_sec).toBe(model === 'wan-2.5' ? 5 : 6)
      expect(await saveShotDurationForUser(admin, primary.user.id, shotId, accepted)).toMatchObject({ success: true })
      expect((await readShot(shotId)).duration_sec).toBe(accepted)
    })
  }
})

test.describe("the agent's update_shot and insert_shot", () => {
  test('Wan 2.5: update_shot rounds a length up to one the model makes; insert_shot takes its length from its words', async () => {
    const projectId = await seedProject('wan-2.5')
    await seedShot(projectId, 5)
    const updated = await handleUpdateShot({ shot_number: 1, duration_sec: 7 }, ctx(projectId))
    expect(updated.kind).toBe('applied')
    const { data: first } = await admin.from('shots').select('duration_sec').eq('project_id', projectId).eq('order_index', 0).single()
    expect(first!.duration_sec).toBe(10)

    const inserted = await handleInsertShot(
      { position: 'end', voice_over: 'Four words spoken here.', visual_description: 'The sea.', duration_sec: 7.3 },
      ctx(projectId)
    )
    expect(inserted.kind).toBe('applied')
    const { data: last } = await admin.from('shots').select('duration_sec').eq('project_id', projectId).eq('order_index', 1).single()
    expect(last!.duration_sec).toBe(5)
  })

  test('Seedance 2.0 Mini: update_shot lifts 2s to 4s; a short inserted shot rises to the 4s minimum', async () => {
    const projectId = await seedProject('seedance-2.0-mini')
    await seedShot(projectId, 6)
    expect((await handleUpdateShot({ shot_number: 1, duration_sec: 2 }, ctx(projectId))).kind).toBe('applied')
    const { data: first } = await admin.from('shots').select('duration_sec').eq('project_id', projectId).eq('order_index', 0).single()
    expect(first!.duration_sec).toBe(4)

    expect((await handleInsertShot({ position: 'end', voice_over: 'Go.', visual_description: 'A door.' }, ctx(projectId))).kind).toBe('applied')
    const { data: last } = await admin.from('shots').select('duration_sec').eq('project_id', projectId).eq('order_index', 1).single()
    expect(last!.duration_sec).toBe(4)
  })
})
