import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { runPromptGeneration } from '../src/app/api/projects/[id]/prompts/logic'
import { successMessage, truncatedMessage, throwingGateway } from './helpers/claude-fakes'
import type { ClaudeGateway } from '../src/lib/claude'

const GOOD_IMAGE_PROMPT =
  'A warm, detailed shot with rich color and lighting that fully describes the moment for an image generation model.'
const GOOD_VIDEO_PROMPT =
  'A slow, deliberate camera movement across the shot, describing exactly how motion unfolds within the frame.'

/** A deterministic fake write_prompts gateway: returns a complete entry for every key
 * in shotKeys except any listed in opts.omitKeys, and counts how many times it's called. */
function fakeGateway(shotKeys: string[], opts?: { truncated?: boolean; omitKeys?: string[] }) {
  let calls = 0
  const included = shotKeys.filter((k) => !opts?.omitKeys?.includes(k))
  const input = {
    prompts: included.map((shot_key) => ({
      shot_key,
      image_prompt: GOOD_IMAGE_PROMPT,
      video_prompt: GOOD_VIDEO_PROMPT,
    })),
  }
  const gateway: ClaudeGateway = {
    async createMessage() {
      calls++
      return opts?.truncated
        ? truncatedMessage(input, 'write_prompts')
        : successMessage(input, 'write_prompts')
    },
  }
  return { gateway, getCalls: () => calls }
}

async function insertProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({ user_id: userId, title: 'Untitled project', current_step: 'workbench' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function insertShots(
  projectId: string,
  shots: { shot_key: string; image_prompt?: string | null; video_prompt?: string | null }[]
) {
  const rows = shots.map((s, index) => ({
    project_id: projectId,
    order_index: index,
    shot_key: s.shot_key,
    voice_over: `Voice over for ${s.shot_key}`,
    image_prompt: s.image_prompt ?? null,
    video_prompt: s.video_prompt ?? null,
  }))
  const { error } = await admin.from('shots').insert(rows)
  expect(error).toBeNull()
}

async function readGeneration(projectId: string) {
  const { data, error } = await admin
    .from('generations')
    .select('state, payload, error')
    .eq('project_id', projectId)
    .eq('step', 'image_prompts')
    .eq('operation', 'write_prompts')
    .is('shot_id', null)
    .single()
  expect(error).toBeNull()
  return data!
}

test.describe('Step 4 (provisional) - image/video prompt generation', () => {
  test('writes prompts for shots that need them, settles succeeded, and logs a usage row carrying generation_id', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }, { shot_key: 'f4g5h' }])

      const { gateway, getCalls } = fakeGateway(['b2c3d', 'f4g5h'])

      const result = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(result.ok).toBe(true)
      expect(getCalls()).toBe(1)

      const { data: shots, error: shotsError } = await admin
        .from('shots')
        .select('shot_key, image_prompt, video_prompt')
        .eq('project_id', projectId)
      expect(shotsError).toBeNull()
      for (const s of shots!) {
        expect(s.image_prompt).toBe(GOOD_IMAGE_PROMPT)
        expect(s.video_prompt).toBe(GOOD_VIDEO_PROMPT)
      }

      const { data: project, error: projectError } = await admin
        .from('projects')
        .select('current_step')
        .eq('id', projectId)
        .single()
      expect(projectError).toBeNull()
      expect(project!.current_step).toBe('workbench')

      const generation = await readGeneration(projectId)
      expect(generation.state).toBe('succeeded')
      expect(generation.payload).toBeNull()

      const { data: usageRows, error: usageError } = await admin
        .from('usage')
        .select('generation_id, step, operation, status, estimated_cost')
        .eq('project_id', projectId)
      expect(usageError).toBeNull()
      expect(usageRows!.length).toBe(1)
      expect(usageRows![0].generation_id).not.toBeNull()
      expect(usageRows![0].step).toBe('image_prompts')
      expect(usageRows![0].operation).toBe('write_prompts')
      expect(usageRows![0].status).toBe('succeeded')
      expect(usageRows![0].estimated_cost).not.toBeNull()
    }
  })

  test('a response missing requested shot_keys returns 422, does not advance current_step, and leaves the payload intact', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }, { shot_key: 'f4g5h' }])

      const { gateway } = fakeGateway(['b2c3d', 'f4g5h'], { omitKeys: ['f4g5h'] })

      const result = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(result.ok).toBe(false)
      if (!result.ok && result.status === 422) {
        expect(result.missingShotKeys).toEqual(['f4g5h'])
      } else {
        throw new Error(`expected a 422, got ${JSON.stringify(result)}`)
      }

      const { data: project } = await admin
        .from('projects')
        .select('current_step')
        .eq('id', projectId)
        .single()
      expect(project!.current_step).toBe('workbench')

      // Mirrors /shots' own "nothing usable" 422: the payload is left intact for
      // recovery rather than cleared, unlike the max_tokens truncation case.
      const generation = await readGeneration(projectId)
      expect(generation.state).toBe('failed')
      expect(generation.payload).not.toBeNull()
    }
  })

  test('two concurrent calls on a fresh identity: exactly one claims and calls Claude, the other is blocked as already_generating', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }])

      const { gateway, getCalls } = fakeGateway(['b2c3d'])

      const [first, second] = await Promise.all([
        runPromptGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false }),
        runPromptGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false }),
      ])

      const outcomes = [first.ok, second.ok].sort()
      expect(outcomes).toEqual([false, true])

      const blocked = [first, second].find((r) => !r.ok)
      expect(blocked && !blocked.ok && blocked.status).toBe(409)
      expect(blocked && !blocked.ok && 'reason' in blocked && blocked.reason).toBe(
        'already_generating'
      )

      expect(getCalls()).toBe(1)
    }
  })

  test('a persisted payload with derived rows not yet written is replayed without a second Claude call', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }, { shot_key: 'f4g5h' }])

      const payload = {
        prompts: [
          { shot_key: 'b2c3d', image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT },
          { shot_key: 'f4g5h', image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT },
        ],
      }

      const { error: generationError } = await admin.from('generations').insert({
        project_id: projectId,
        step: 'image_prompts',
        operation: 'write_prompts',
        shot_id: null,
        state: 'failed',
        payload: payload as never,
      })
      expect(generationError).toBeNull()

      const { gateway, getCalls } = fakeGateway(['b2c3d', 'f4g5h'])

      const result = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: true,
      })
      expect(result.ok).toBe(true)
      expect(getCalls()).toBe(0)

      const { data: shots } = await admin
        .from('shots')
        .select('image_prompt, video_prompt')
        .eq('project_id', projectId)
      for (const s of shots!) {
        expect(s.image_prompt).toBe(GOOD_IMAGE_PROMPT)
        expect(s.video_prompt).toBe(GOOD_VIDEO_PROMPT)
      }

      const generation = await readGeneration(projectId)
      expect(generation.state).toBe('succeeded')
      expect(generation.payload).toBeNull()
    }
  })

  test('a max_tokens truncation settles failed and clears the payload so a retry calls Claude fresh', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }])

      const { gateway } = fakeGateway(['b2c3d'], { truncated: true })

      const result = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(422)

      const generation = await readGeneration(projectId)
      expect(generation.state).toBe('failed')
      expect(generation.payload).toBeNull()
    }
  })

  test('a succeeded claim blocks a further call with already_ready unless retry is true', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }])

      const { gateway } = fakeGateway(['b2c3d'])
      const first = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(first.ok).toBe(true)

      const second = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(second.ok).toBe(false)
      expect(second.status).toBe(409)
      expect(!second.ok && 'reason' in second && second.reason).toBe('already_ready')
    }
  })

  test('a project with nothing left to generate settles succeeded with no Claude call and no usage row', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [
        { shot_key: 'b2c3d', image_prompt: GOOD_IMAGE_PROMPT, video_prompt: GOOD_VIDEO_PROMPT },
      ])

      const { gateway, getCalls } = fakeGateway(['b2c3d'])
      const result = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(result.ok).toBe(true)
      expect(getCalls()).toBe(0)

      const generation = await readGeneration(projectId)
      expect(generation.state).toBe('succeeded')

      const { data: usageRows } = await admin.from('usage').select('id').eq('project_id', projectId)
      expect(usageRows!.length).toBe(0)
    }
  })

  test('a gateway call that throws still leaves a usage row, failed, with a non-null estimated cost', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }])
      const gateway = throwingGateway('simulated network failure')

      const result = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(result.ok).toBe(false)

      const { data: usageRows, error: usageError } = await admin
        .from('usage')
        .select('status, estimated_cost, step, operation')
        .eq('project_id', projectId)
      expect(usageError).toBeNull()
      expect(usageRows!.length).toBe(1)
      expect(usageRows![0].status).toBe('failed')
      expect(usageRows![0].estimated_cost).not.toBeNull()
      expect(usageRows![0].step).toBe('image_prompts')
      expect(usageRows![0].operation).toBe('write_prompts')
    }
  })

  test('a successful call writes exactly one succeeded usage row with a measured cost below the quote', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }, { shot_key: 'f4g5h' }])
      const { gateway } = fakeGateway(['b2c3d', 'f4g5h'])

      const result = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(result.ok).toBe(true)

      const { data: usageRows, error: usageError } = await admin
        .from('usage')
        .select('status, estimated_cost, quantity, raw_usage')
        .eq('project_id', projectId)
      expect(usageError).toBeNull()
      expect(usageRows!.length).toBe(1)
      expect(usageRows![0].status).toBe('succeeded')
      expect(usageRows![0].quantity).toBe(20) // successMessage's fixed 10 input + 10 output tokens
      const raw = usageRows![0].raw_usage as { quoted?: unknown }
      // settle fully overwrites raw_usage - the reserve-time quote should be gone.
      expect(raw.quoted).toBeUndefined()
      expect(usageRows![0].estimated_cost).toBeGreaterThan(0)
      expect(usageRows![0].estimated_cost).toBeLessThan(0.001)
    }
  })

  test('a max_tokens truncation writes a failed usage row with stop_reason max_tokens and a measured cost', async () => {
    const user = primary.user
    {
      const projectId = await insertProject(user.id)
      await insertShots(projectId, [{ shot_key: 'b2c3d' }])
      const { gateway } = fakeGateway(['b2c3d'], { truncated: true })

      const result = await runPromptGeneration({
        gateway,
        supabase: admin,
        projectId,
        userId: user.id,
        retry: false,
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(422)

      const { data: usageRows, error: usageError } = await admin
        .from('usage')
        .select('status, stop_reason, estimated_cost')
        .eq('project_id', projectId)
      expect(usageError).toBeNull()
      expect(usageRows!.length).toBe(1)
      expect(usageRows![0].status).toBe('failed')
      expect(usageRows![0].stop_reason).toBe('max_tokens')
      expect(usageRows![0].estimated_cost).not.toBeNull()
    }
  })
})
