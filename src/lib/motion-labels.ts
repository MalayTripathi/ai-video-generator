import type { Motion, Transition } from '@/lib/config/enums'

// Display labels for the Storyboard's motion and transition codes. Display-only: stored
// values, the enum tuples and the DB CHECK constraints stay exactly as persisted.

export const MOTION_LABELS: Record<Motion, string> = {
  push_in: 'Push in',
  pull_out: 'Pull out',
  pan_left: 'Pan left',
  pan_right: 'Pan right',
  pan_up: 'Pan up',
  pan_down: 'Pan down',
  static: 'Static',
}

// What a block too narrow for the label shows instead.
export const MOTION_GLYPHS: Record<Motion, string> = {
  push_in: '⊕',
  pull_out: '⊖',
  pan_left: '←',
  pan_right: '→',
  pan_up: '↑',
  pan_down: '↓',
  static: '—',
}

export const TRANSITION_LABELS: Record<Transition, string> = { cut: 'Cut', dissolve: 'Dissolve' }
