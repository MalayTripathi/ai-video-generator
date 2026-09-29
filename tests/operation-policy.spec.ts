import { test, expect } from '@playwright/test'
import { OPERATIONS, type Operation } from '../src/lib/config/pipeline'
import { OPERATION_POLICY, getOperationPolicy, STALE_AFTER_MS } from '../src/lib/generations/operation-policy'
import {
  IMAGE_QUEUE_STALE_AFTER_MS,
  IMAGE_STALE_AFTER_MS,
  MUSIC_PROMPT_STALE_AFTER_MS,
  MUSIC_STALE_AFTER_MS,
  VOICEOVER_ALIGN_STALE_AFTER_MS,
  VOICEOVER_ROUTE_MAX_DURATION_S,
  VOICEOVER_STALE_AFTER_MS,
} from '../src/lib/config/storyboard'

const DEFAULT_POLICY_OPS: Operation[] = [
  'write_video_prompts',
  'generate_clip',
  'merge',
  'derive_camera',
]

test.describe('OPERATION_POLICY', () => {
  test('has an entry for every Operation - drift guard against pipeline.ts', () => {
    expect(Object.keys(OPERATION_POLICY).sort()).toEqual([...OPERATIONS].sort())
  })

  test('voiceover / align_voiceover: own windows, reclaimable from either terminal state (regenerate is a new attempt)', () => {
    const vo = getOperationPolicy('voiceover')
    expect(vo.staleAfterMs).toBe(VOICEOVER_STALE_AFTER_MS)
    expect(vo.claimableFrom).toEqual({ succeeded: 'always', failed: 'always' })
    const align = getOperationPolicy('align_voiceover')
    expect(align.staleAfterMs).toBe(VOICEOVER_ALIGN_STALE_AFTER_MS)
    expect(align.claimableFrom).toEqual({ succeeded: 'always', failed: 'always' })
    // Both windows must fit inside the route's own maxDuration.
    expect(vo.staleAfterMs).toBeLessThan(VOICEOVER_ROUTE_MAX_DURATION_S * 1000)
    expect(align.staleAfterMs).toBeLessThan(VOICEOVER_ROUTE_MAX_DURATION_S * 1000)
  })

  test('background_music: its own window, reclaimable from either terminal state; derive_music_prompt: once per project', () => {
    const music = getOperationPolicy('background_music')
    expect(music.staleAfterMs).toBe(MUSIC_STALE_AFTER_MS)
    expect(music.claimableFrom).toEqual({ succeeded: 'always', failed: 'always' })
    // The music route's maxDuration is the same literal as the voiceover routes'.
    expect(music.staleAfterMs).toBeLessThan(VOICEOVER_ROUTE_MAX_DURATION_S * 1000)
    const derive = getOperationPolicy('derive_music_prompt')
    expect(derive.staleAfterMs).toBe(MUSIC_PROMPT_STALE_AFTER_MS)
    // Never reclaimed once it succeeded; a failure only behind retry:true, which no caller passes.
    expect(derive.claimableFrom).toEqual({ succeeded: 'never', failed: 'retry' })
  })

  test('agent_turn: 180s window, claimable unconditionally from succeeded or failed', () => {
    const policy = getOperationPolicy('agent_turn')
    expect(policy.staleAfterMs).toBe(180 * 1000)
    expect(policy.claimableFrom.succeeded).toBe('always')
    expect(policy.claimableFrom.failed).toBe('always')
  })

  test('generate_shots: default window, claimable from succeeded only with retry (regenerate-all)', () => {
    const policy = getOperationPolicy('generate_shots')
    expect(policy.staleAfterMs).toBe(STALE_AFTER_MS)
    expect(policy.claimableFrom.succeeded).toBe('retry')
    expect(policy.claimableFrom.failed).toBe('retry')
  })

  // Regenerate All / Regenerate Stale / a single row are normal, repeatable actions against a
  // project whose prompts already exist, not exceptional retries - so, like generate_shots, a
  // succeeded row is reclaimable behind the same retry flag a failed one needs (see the
  // write_image_prompts entry in operation-policy.ts). A request without retry is still refused.
  test('write_image_prompts: default window, claimable from succeeded only with retry (regenerate)', () => {
    const policy = getOperationPolicy('write_image_prompts')
    expect(policy.staleAfterMs).toBe(STALE_AFTER_MS)
    expect(policy.claimableFrom.succeeded).toBe('retry')
    expect(policy.claimableFrom.failed).toBe('retry')
  })

  // One claim per shot for the Step 4 image. Generate/Retry/Regenerate are ordinary
  // repeatable actions, so no retry flag from either terminal state; the per-call window
  // comes from storyboard.ts, and a queued claim has its own, longer one.
  test('generate_image: storyboard windows, claimable unconditionally from succeeded or failed', () => {
    const policy = getOperationPolicy('generate_image')
    expect(policy.staleAfterMs).toBe(IMAGE_STALE_AFTER_MS)
    expect(policy.queuedStaleAfterMs).toBe(IMAGE_QUEUE_STALE_AFTER_MS)
    expect(policy.queuedStaleAfterMs!).toBeGreaterThan(policy.staleAfterMs)
    expect(policy.claimableFrom.succeeded).toBe('always')
    expect(policy.claimableFrom.failed).toBe('always')
  })

  test('every other operation is identical to pre-change behaviour: default window, never/retry', () => {
    for (const operation of DEFAULT_POLICY_OPS) {
      const policy = getOperationPolicy(operation)
      expect(policy.staleAfterMs, `staleAfterMs for ${operation}`).toBe(STALE_AFTER_MS)
      expect(policy.claimableFrom.succeeded, `succeeded rule for ${operation}`).toBe('never')
      expect(policy.claimableFrom.failed, `failed rule for ${operation}`).toBe('retry')
    }
  })

  test('throws for an unknown operation', () => {
    expect(() => getOperationPolicy('not_a_real_operation' as Operation)).toThrow()
  })
})
