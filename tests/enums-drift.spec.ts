import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import {
  VIDEO_TYPES,
  ASPECT_RATIOS,
  SHOT_SIZES,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  CAMERA_ORIGINS,
  ELEMENT_TYPES,
} from '../src/lib/config/enums'
import { STEPS, OPERATIONS, PROVIDERS } from '../src/lib/config/pipeline'
import { MESSAGE_KINDS, TOOL_NAMES } from '../src/lib/config/messages'

// Turns TS-vs-CHECK-constraint drift into a test failure instead of a runtime surprise:
// for every enum in src/lib/config/enums.ts that has a DB CHECK constraint, insert a row
// using every member (assert the DB accepts it) and one bogus value (assert rejection).
// The same principle covers src/lib/config/pipeline.ts's STEPS/OPERATIONS/PROVIDERS below,
// mirrored by hand into generations/usage/projects CHECK constraints - see those
// migrations' own comments.

async function insertProject(overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from('projects')
    .insert({ user_id: primary.user.id, title: 'Enum drift test', current_step: 'workbench', ...overrides })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

/**
 * Shared shape for every TS-array-vs-DB-CHECK-constraint pairing below: insert a row for
 * every array member (must be accepted) and one row with a bogus value (must be rejected).
 * Each pairing supplies its own insertValid/insertBogus closures rather than this helper
 * knowing about any particular table's columns.
 */
async function assertEnumDrift<T extends string>(
  array: readonly T[],
  insertValid: (value: T) => PromiseLike<{ error: { code?: string } | null }>,
  insertBogus: () => PromiseLike<{ error: { code?: string } | null }>
) {
  for (const value of array) {
    const { error } = await insertValid(value)
    expect(error, `expected ${value} to be accepted`).toBeNull()
  }

  const { error: badError } = await insertBogus()
  expect(badError).not.toBeNull()
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

  // current_step's vocabulary is STEPS exactly - intake is the pre-project screen and
  // never a stored value. This is the check that would have caught the 'script'
  // divergence, when the column had no CHECK constraint at all.
  test('accepts every STEPS member as current_step and rejects a bogus value', async () => {
    await assertEnumDrift(
      STEPS,
      (value) =>
        admin.from('projects').insert({ user_id: primary.user.id, title: 'Enum drift test', current_step: value }),
      () =>
        admin
          .from('projects')
          .insert({ user_id: primary.user.id, title: 'Enum drift test', current_step: 'not_a_real_step' })
    )
  })
})

// generations/usage CHECK constraints validate step and operation independently (the
// (step, operation) pairing in STEP_OPERATIONS is app-enforced only - see those tables'
// migrations), so a single valid constant for whichever column isn't under test works
// regardless of which step or operation it names.
const HELD_OPERATION = 'agent_turn' as const
const HELD_STEP = 'workbench' as const

test.describe('enum drift - generations columns', () => {
  // Each test below claims its own fresh project via insertProject(), so no two tests
  // ever share a project_id - the first of two layers preventing a collision against
  // generations_identity_idx's (project_id, step, operation, shot_id) unique index
  // (NULLS NOT DISTINCT). The second layer: within one test's loop, only the column
  // under test varies while every other identity column stays fixed - STEPS/OPERATIONS
  // have no duplicate members by construction, so every row (plus the final bogus-value
  // row) has a distinct identity tuple even before accounting for the fresh project_id.
  test('accepts every STEPS member as generations.step and rejects a bogus value', async () => {
    const projectId = await insertProject()
    await assertEnumDrift(
      STEPS,
      (value) =>
        admin.from('generations').insert({ project_id: projectId, step: value, operation: HELD_OPERATION, shot_id: null }),
      () =>
        admin
          .from('generations')
          .insert({ project_id: projectId, step: 'not_a_real_step', operation: HELD_OPERATION, shot_id: null })
    )
  })

  // derive_camera is deliberately excluded from generations_operation_check - no writer
  // ever claims a generations row for it (the terminal 'succeeded' state would block
  // every later description edit of the same shot - see CLAUDE.md), so widening the
  // constraint to accept it would misleadingly imply a writer exists. OPERATIONS has 11
  // members; this constraint only ever accepts 10 of them, by design. Accepting it here
  // would itself be the bug, so it's excluded from the accept-loop and asserted rejected
  // instead, turning that invariant into a regression test rather than silently
  // narrowing coverage.
  test('accepts every non-derive_camera OPERATIONS member as generations.operation, rejects derive_camera and a bogus value', async () => {
    const projectId = await insertProject()
    const claimableOperations = OPERATIONS.filter((op) => op !== 'derive_camera')

    await assertEnumDrift(
      claimableOperations,
      (value) =>
        admin.from('generations').insert({ project_id: projectId, step: HELD_STEP, operation: value, shot_id: null }),
      () =>
        admin
          .from('generations')
          .insert({ project_id: projectId, step: HELD_STEP, operation: 'not_a_real_operation', shot_id: null })
    )

    const { error: deriveCameraError } = await admin
      .from('generations')
      .insert({ project_id: projectId, step: HELD_STEP, operation: 'derive_camera', shot_id: null })
    expect(deriveCameraError, 'derive_camera must never be insertable into generations').not.toBeNull()
  })
})

test.describe('enum drift - usage columns', () => {
  test('accepts every STEPS member as usage.step and rejects a bogus value', async () => {
    const projectId = await insertProject()
    await assertEnumDrift(
      STEPS,
      (value) =>
        admin.from('usage').insert({
          user_id: primary.user.id,
          project_id: projectId,
          step: value,
          operation: HELD_OPERATION,
          provider: 'anthropic',
          model: 'test-model',
        }),
      () =>
        admin.from('usage').insert({
          user_id: primary.user.id,
          project_id: projectId,
          step: 'not_a_real_step',
          operation: HELD_OPERATION,
          provider: 'anthropic',
          model: 'test-model',
        })
    )
  })

  // Unlike generations, usage_operation_check already includes derive_camera (it's the
  // only paid call that writes a usage row with no matching generations claim), so this
  // pairing is a clean 1:1 match against the full OPERATIONS array.
  test('accepts every OPERATIONS member as usage.operation and rejects a bogus value', async () => {
    const projectId = await insertProject()
    await assertEnumDrift(
      OPERATIONS,
      (value) =>
        admin.from('usage').insert({
          user_id: primary.user.id,
          project_id: projectId,
          step: HELD_STEP,
          operation: value,
          provider: 'anthropic',
          model: 'test-model',
        }),
      () =>
        admin.from('usage').insert({
          user_id: primary.user.id,
          project_id: projectId,
          step: HELD_STEP,
          operation: 'not_a_real_operation',
          provider: 'anthropic',
          model: 'test-model',
        })
    )
  })

  test('accepts every PROVIDERS member as usage.provider and rejects a bogus value', async () => {
    const projectId = await insertProject()
    await assertEnumDrift(
      PROVIDERS,
      (value) =>
        admin.from('usage').insert({
          user_id: primary.user.id,
          project_id: projectId,
          step: HELD_STEP,
          operation: HELD_OPERATION,
          provider: value,
          model: 'test-model',
        }),
      () =>
        admin.from('usage').insert({
          user_id: primary.user.id,
          project_id: projectId,
          step: HELD_STEP,
          operation: HELD_OPERATION,
          provider: 'not_a_real_provider',
          model: 'test-model',
        })
    )
  })
})

test.describe('enum drift - credit_ledger columns', () => {
  // Every row here is a valid 'spend' (credit_ledger_spend_fields_check requires
  // step/operation/attempt_id/pricing_mode all non-null), with a fresh attempt_id
  // per row so dedupe_key is unique per row against the (user_id, dedupe_key)
  // index - no other collision handling is needed, valid or bogus rows alike.
  function spendRow(overrides: { step: string; operation: string }) {
    const attemptId = crypto.randomUUID()
    return {
      user_id: primary.user.id,
      kind: 'spend',
      delta: -1,
      attempt_id: attemptId,
      pricing_mode: 'fixed',
      dedupe_key: `${overrides.operation}:${attemptId}`,
      price_version: 'test',
      ...overrides,
    }
  }

  test('accepts every STEPS member as credit_ledger.step and rejects a bogus value', async () => {
    await assertEnumDrift(
      STEPS,
      (value) => admin.from('credit_ledger').insert(spendRow({ step: value, operation: HELD_OPERATION })),
      () => admin.from('credit_ledger').insert(spendRow({ step: 'not_a_real_step', operation: HELD_OPERATION }))
    )
  })

  test('accepts every OPERATIONS member as credit_ledger.operation and rejects a bogus value', async () => {
    await assertEnumDrift(
      OPERATIONS,
      (value) => admin.from('credit_ledger').insert(spendRow({ step: HELD_STEP, operation: value })),
      () => admin.from('credit_ledger').insert(spendRow({ step: HELD_STEP, operation: 'not_a_real_operation' }))
    )
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

  test('accepts every CAMERA_ORIGINS member and rejects a bogus value', async () => {
    const projectId = await insertProject()
    for (const value of CAMERA_ORIGINS) {
      const { orderIndex, shotKey } = nextShotIdentity()
      const { error } = await admin.from('shots').insert({
        project_id: projectId,
        order_index: orderIndex,
        shot_key: shotKey,
        voice_over: 'x',
        shot_size_origin: value,
      })
      expect(error).toBeNull()
    }

    const bad = nextShotIdentity()
    const { error: badError } = await admin.from('shots').insert({
      project_id: projectId,
      order_index: bad.orderIndex,
      shot_key: bad.shotKey,
      voice_over: 'x',
      shot_size_origin: 'not_a_real_origin',
    })
    expect(badError).not.toBeNull()
  })
})

test.describe('enum drift - messages columns', () => {
  test('accepts every MESSAGE_KINDS member and rejects a bogus value', async () => {
    const projectId = await insertProject()
    for (const value of MESSAGE_KINDS) {
      const { error } = await admin.from('messages').insert({
        project_id: projectId,
        role: 'assistant',
        content: 'x',
        kind: value,
      })
      expect(error).toBeNull()
    }

    const { error: badError } = await admin.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      content: 'x',
      kind: 'not_a_real_kind',
    })
    expect(badError).not.toBeNull()
  })

  test('accepts every TOOL_NAMES member (plus null) as tool_name and rejects a bogus value', async () => {
    const projectId = await insertProject()
    for (const value of TOOL_NAMES) {
      const { error } = await admin.from('messages').insert({
        project_id: projectId,
        role: 'assistant',
        content: 'x',
        kind: 'tool_done',
        tool_name: value,
      })
      expect(error).toBeNull()
    }

    const { error: nullError } = await admin.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      content: 'x',
      kind: 'refusal',
      tool_name: null,
    })
    expect(nullError).toBeNull()

    const { error: badError } = await admin.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      content: 'x',
      kind: 'tool_done',
      tool_name: 'not_a_real_tool',
    })
    expect(badError).not.toBeNull()
  })
})

test.describe('enum drift - elements columns', () => {
  test('accepts every ELEMENT_TYPES member and rejects a bogus value', async () => {
    const projectId = await insertProject()
    let seq = 0
    for (const value of ELEMENT_TYPES) {
      seq++
      const { error } = await admin.from('elements').insert({
        project_id: projectId,
        name: `Enum drift element ${seq}`,
        type: value,
      })
      expect(error).toBeNull()
    }

    seq++
    const { error: badError } = await admin.from('elements').insert({
      project_id: projectId,
      name: `Enum drift element ${seq}`,
      type: 'not_a_real_type',
    })
    expect(badError).not.toBeNull()
  })
})
