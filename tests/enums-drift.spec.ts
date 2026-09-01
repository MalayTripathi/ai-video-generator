import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import {
  VIDEO_TYPES,
  ASPECT_RATIOS,
  SHOT_SIZES,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
} from '../src/lib/config/enums'

// Turns TS-vs-CHECK-constraint drift into a test failure instead of a runtime surprise:
// for every enum in src/lib/config/enums.ts that has a DB CHECK constraint, insert a row
// using every member (assert the DB accepts it) and one bogus value (assert rejection).
//
// element_type has no DB CHECK constraint on elements.type (confirmed by migration grep),
// so it's excluded here - there's nothing to assert DB rejection against.

async function insertProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({ user_id: primary.user.id, title: 'Enum drift test', current_step: 'workbench', ...overrides })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

// Each call returns a fresh (order_index, shot_key) pair so repeated inserts into the
// same project never collide with the shots_project_id_order_index_key unique constraint.
let seq = 0
function nextShotIdentity() {
  seq++
  return { orderIndex: seq, shotKey: `zk${String(seq).padStart(3, '0')}` }
}

test.describe('enum drift - projects columns', () => {
  test('accepts every VIDEO_TYPES member and rejects a bogus value', async () => {
    for (const value of VIDEO_TYPES) {
      const { error } = await admin
        .from('projects')
        .insert({ user_id: primary.user.id, title: 'Enum drift test', current_step: 'workbench', video_type: value })
      expect(error).toBeNull()
    }

    const { error: badError } = await admin
      .from('projects')
      .insert({
        user_id: primary.user.id,
        title: 'Enum drift test',
        current_step: 'workbench',
        video_type: 'not_a_real_video_type',
      })
    expect(badError).not.toBeNull()
  })

  test('accepts every ASPECT_RATIOS member and rejects a bogus value', async () => {
    for (const value of ASPECT_RATIOS) {
      const { error } = await admin
        .from('projects')
        .insert({
          user_id: primary.user.id,
          title: 'Enum drift test',
          current_step: 'workbench',
          aspect_ratio: value,
        })
      expect(error).toBeNull()
    }

    const { error: badError } = await admin
      .from('projects')
      .insert({
        user_id: primary.user.id,
        title: 'Enum drift test',
        current_step: 'workbench',
        aspect_ratio: 'not_a_real_ratio',
      })
    expect(badError).not.toBeNull()
  })
})

test.describe('enum drift - shots columns', () => {
  test('accepts every SHOT_SIZES member and rejects a bogus value', async () => {
    const projectId = await insertProject()
    for (const value of SHOT_SIZES) {
      const { orderIndex, shotKey } = nextShotIdentity()
      const { error } = await admin.from('shots').insert({
        project_id: projectId,
        order_index: orderIndex,
        shot_key: shotKey,
        voice_over: 'x',
        shot_size: value,
      })
      expect(error).toBeNull()
    }

    const bad = nextShotIdentity()
    const { error: badError } = await admin.from('shots').insert({
      project_id: projectId,
      order_index: bad.orderIndex,
      shot_key: bad.shotKey,
      voice_over: 'x',
      shot_size: 'not_a_real_size',
    })
    expect(badError).not.toBeNull()
  })

  test('accepts every CAMERA_ANGLES member and rejects a bogus value', async () => {
    const projectId = await insertProject()
    for (const value of CAMERA_ANGLES) {
      const { orderIndex, shotKey } = nextShotIdentity()
      const { error } = await admin.from('shots').insert({
        project_id: projectId,
        order_index: orderIndex,
        shot_key: shotKey,
        voice_over: 'x',
        camera_angle: value,
      })
      expect(error).toBeNull()
    }

    const bad = nextShotIdentity()
    const { error: badError } = await admin.from('shots').insert({
      project_id: projectId,
      order_index: bad.orderIndex,
      shot_key: bad.shotKey,
      voice_over: 'x',
      camera_angle: 'not_a_real_angle',
    })
    expect(badError).not.toBeNull()
  })

  test('accepts every CAMERA_MOVEMENTS member and rejects a bogus value', async () => {
    const projectId = await insertProject()
    for (const value of CAMERA_MOVEMENTS) {
      const { orderIndex, shotKey } = nextShotIdentity()
      const { error } = await admin.from('shots').insert({
        project_id: projectId,
        order_index: orderIndex,
        shot_key: shotKey,
        voice_over: 'x',
        camera_movement: value,
      })
      expect(error).toBeNull()
    }

    const bad = nextShotIdentity()
    const { error: badError } = await admin.from('shots').insert({
      project_id: projectId,
      order_index: bad.orderIndex,
      shot_key: bad.shotKey,
      voice_over: 'x',
      camera_movement: 'not_a_real_movement',
    })
    expect(badError).not.toBeNull()
  })
})
