import { test, expect } from '@playwright/test'
import { OPERATIONS, type Operation } from '../src/lib/config/pipeline'
import { OPERATION_POLICY, getOperationPolicy, STALE_AFTER_MS } from '../src/lib/generations/operation-policy'

const DEFAULT_POLICY_OPS: Operation[] = [
  'voiceover',
  'background_music',
  'write_video_prompts',
  'generate_image',
  'generate_clip',
  'merge',
  'derive_camera',
]

test.describe('OPERATION_POLICY', () => {
  test('has an entry for every Operation - drift guard against pipeline.ts', () => {
    expect(Object.keys(OPERATION_POLICY).sort()).toEqual([...OPERATIONS].sort())
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
