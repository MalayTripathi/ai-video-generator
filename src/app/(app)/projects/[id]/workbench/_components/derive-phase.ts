import type { ShotsGenerationStatus } from '@/app/api/projects/[id]/shots/logic'

export type Phase = 'generating' | 'list' | 'failed' | 'partial' | 'trigger'

export function derivePhase({
  shotsGeneration,
  shotCount,
}: {
  shotsGeneration: ShotsGenerationStatus
  shotCount: number
}): Phase {
  if (shotsGeneration === 'pending') return 'trigger'
  if (shotsGeneration === 'generating') return 'generating'
  if (shotsGeneration === 'ready') return shotCount === 0 ? 'failed' : 'list'
  // 'failed'
  return shotCount === 0 ? 'failed' : 'partial'
}
