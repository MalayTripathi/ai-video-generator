export type Phase = 'generating' | 'list' | 'failed' | 'partial' | 'trigger'

export function derivePhase({
  generation,
  shotCount,
}: {
  generation: { state: string } | null
  shotCount: number
}): Phase {
  if (!generation || generation.state === 'pending') return 'trigger'
  if (generation.state === 'generating') return 'generating'
  if (generation.state === 'succeeded') return shotCount === 0 ? 'failed' : 'list'
  // 'failed'
  return shotCount === 0 ? 'failed' : 'partial'
}
