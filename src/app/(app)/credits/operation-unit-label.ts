import type { Operation } from '@/lib/config/pipeline'

// The credits page's replacement for the dollar page's "N calls" sublabel - the ledger
// counts actions (one row per turn/generation/derivation), not provider calls, so the
// unit word must say what kind of action it is. Never render a raw operation value
// itself (CLAUDE.md hard rule 14); this only ever emits plain English words. Falls back
// to "action"/"actions" for any operation not yet listed here, so a new priced
// operation never breaks rendering.
const UNIT_WORDS: Partial<Record<Operation, [singular: string, plural: string]>> = {
  agent_turn: ['turn', 'turns'],
  generate_shots: ['generation', 'generations'],
  derive_camera: ['derivation', 'derivations'],
}

export function operationUnitLabel(operation: Operation, count: number): string {
  const [singular, plural] = UNIT_WORDS[operation] ?? ['action', 'actions']
  return `${count} ${count === 1 ? singular : plural}`
}
