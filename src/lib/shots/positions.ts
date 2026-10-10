import { SHOT_ORDER_BASE, SHOT_ORDER_SCENE_STRIDE, SHOTS_PER_CHUNK } from '@/lib/config/shots'

// Shot positions while a chain is writing: each chunk's shots take an order_index derived
// from the scene's position and the shot's place in the scene, so chunks running in
// parallel never collide. The chain's end re-sequences the project to 0..n-1. Pure.

/** A chunk shot's provisional order_index. */
export function chunkShotOrderIndex(scenePosition: number, chunkIndex: number, indexInChunk: number): number {
  return SHOT_ORDER_BASE + scenePosition * SHOT_ORDER_SCENE_STRIDE + chunkIndex * SHOTS_PER_CHUNK + indexInChunk
}

export type SequencedShot = { id: string; order_index: number; scenePosition: number | null }

/**
 * The contiguous order a project's shots take after a run: by scene position, then by
 * current order_index within a scene - so shots a person already had in a scene stay ahead
 * of ones a later run added to it. A shot with no scene stays with the shot before it.
 * Returns only the shots whose order_index changes, with their new value.
 */
export function resequence(shots: readonly SequencedShot[]): { id: string; order_index: number }[] {
  const byCurrent = [...shots].sort((a, b) => a.order_index - b.order_index)
  let carried = -1
  const keyed = byCurrent.map((shot) => {
    if (shot.scenePosition !== null) carried = shot.scenePosition
    return { shot, scene: shot.scenePosition ?? carried }
  })
  keyed.sort((a, b) => a.scene - b.scene || a.shot.order_index - b.shot.order_index)
  return keyed
    .map(({ shot }, index) => ({ id: shot.id, from: shot.order_index, order_index: index }))
    .filter((s) => s.from !== s.order_index)
    .map(({ id, order_index }) => ({ id, order_index }))
}
