// Single source of truth for the pipeline's step/operation/provider
// vocabulary. Mirrored by hand into the `generations`/`usage` table CHECK
// constraints in supabase/migrations/*.sql - Postgres CHECK constraints
// can't import a TS module, so keep both in sync whenever this file
// changes (see CLAUDE.md's `generations`/`usage` notes).
//
// Step 5 (storyboard) is intentionally absent from STEPS/STEP_OPERATIONS:
// it arranges existing shot images/prompts and generates nothing of its
// own, so it never claims a generation or logs usage.

export const STEPS = [
  'workbench',
  'voiceover',
  'image_prompts',
  'video_prompts',
  'generation',
  'assembly',
] as const

export type Step = (typeof STEPS)[number]

export const OPERATIONS = [
  'generate_shots',
  'agent_turn',
  'voiceover',
  'background_music',
  'write_prompts',
  'generate_image',
  'generate_clip',
  'merge',
  // derive_camera writes a `usage` row but deliberately never a `generations` row - see
  // CLAUDE.md: a claim's terminal 'succeeded' state would block every subsequent edit
  // of the same shot's description. generations_operation_check is not widened for it.
  'derive_camera',
] as const

export type Operation = (typeof OPERATIONS)[number]

export const PROVIDERS = ['anthropic', 'openai', 'elevenlabs', 'fal'] as const

export type Provider = (typeof PROVIDERS)[number]

export const STEP_OPERATIONS: Record<Step, readonly Operation[]> = {
  workbench: ['generate_shots', 'agent_turn', 'derive_camera'],
  voiceover: ['voiceover', 'background_music'],
  image_prompts: ['write_prompts', 'generate_image'],
  video_prompts: ['write_prompts'],
  generation: ['generate_clip'],
  assembly: ['merge'],
}

// User-facing labels only - users must never see a raw step/operation
// value or a provider/model name. Every pair listed in STEP_OPERATIONS
// must have an entry here.
const STEP_LABELS: Record<Step, string> = {
  workbench: 'Workbench',
  voiceover: 'Voiceover',
  image_prompts: 'Image Prompts',
  video_prompts: 'Video Prompts',
  generation: 'Generation',
  assembly: 'Assembly',
}

const OPERATION_LABELS: Record<Step, Partial<Record<Operation, string>>> = {
  workbench: { generate_shots: 'New shots', agent_turn: 'Agent turn', derive_camera: 'Camera framing' },
  voiceover: { voiceover: 'Generation', background_music: 'Background music' },
  image_prompts: { write_prompts: 'Prompt writing', generate_image: 'Image generation' },
  video_prompts: { write_prompts: 'Prompt writing' },
  generation: { generate_clip: 'Clip generation' },
  assembly: { merge: 'Assembly' },
}

/**
 * Renders a (step, operation) pair as a user-facing string, e.g.
 * "Workbench — New shots". Falls back to the raw value only for a pair
 * outside STEP_OPERATIONS, which should never happen for data typed
 * through Step/Operation.
 */
export function stepOperationLabel(step: Step, operation: Operation): string {
  const stepLabel = STEP_LABELS[step] ?? step
  const operationLabel = OPERATION_LABELS[step]?.[operation] ?? operation
  return `${stepLabel} — ${operationLabel}`
}

// Position of `step` in the project's overall progress scale, where intake
// occupies the conceptual first slot (1) without being a member of Step -
// see CLAUDE.md: intake is a pre-project screen, never a tracked step. This
// keeps stepIndex('workbench') === 2, matching both the furthest_step values
// already backfilled by migration 20260826162156_step_progress.sql and the
// literal `furthest_step: 2` written at project creation
// (src/app/(app)/projects/new/actions.ts).
//
// KNOWN GAP: storyboard is a real current_step value (CLAUDE.md's 8-step
// route list) but is not a member of Step - deliberately, since Step is the
// operations-attribution vocabulary mirrored into the generations/usage
// CHECK constraints, and storyboard claims no generation and logs no usage
// (see the file header above). Nothing writes current_step past 'workbench'
// today, so this has no live consequence yet. Whoever builds Step 5's slice
// must extend the current_step vocabulary (and this function, and
// advanceStep's parameter type) at that time - do not preemptively widen
// STEPS to include it, which would incorrectly imply storyboard belongs in
// the generations/usage CHECK constraints too.
export function stepIndex(step: Step): number {
  return STEPS.indexOf(step) + 2
}
