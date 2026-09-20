// Single source of truth for the pipeline's step/operation/provider
// vocabulary. Mirrored by hand into the `generations`/`usage` table CHECK
// constraints in supabase/migrations/*.sql - Postgres CHECK constraints
// can't import a TS module, so keep both in sync whenever this file
// changes (see CLAUDE.md's `generations`/`usage` notes).
//
// Storyboard absorbed the former standalone voiceover step: it owns
// generate_image, voiceover and background_music, so it both claims
// generations and logs usage.

export const STEPS = [
  'workbench',
  'image_prompts',
  'storyboard',
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
  'write_image_prompts',
  'write_video_prompts',
  'generate_image',
  'generate_clip',
  'merge',
  // derive_camera writes a `usage` row but deliberately never a `generations` row - see
  // CLAUDE.md: a claim's terminal 'succeeded' state would block every subsequent edit
  // of the same shot's description. generations_operation_check is not widened for it.
  'derive_camera',
  // Reference-image generation for a single element, at the workbench step. Distinct
  // from storyboard/generate_image (the Step 4 frame render) - different price,
  // different reporting bucket, two different things that happen to both be images.
  'generate_element_reference',
] as const

export type Operation = (typeof OPERATIONS)[number]

// The steps whose agent panel is wired (agent/steps.ts registers one config per entry).
// Sent by the client with each turn and validated against this list server-side.
export const AGENT_STEPS = ['workbench', 'image_prompts', 'storyboard'] as const satisfies readonly Step[]

export type AgentStep = (typeof AGENT_STEPS)[number]

export function isAgentStep(value: unknown): value is AgentStep {
  return typeof value === 'string' && (AGENT_STEPS as readonly string[]).includes(value)
}

export const PROVIDERS = ['anthropic', 'openai', 'elevenlabs', 'fal'] as const

export type Provider = (typeof PROVIDERS)[number]

export const STEP_OPERATIONS: Record<Step, readonly Operation[]> = {
  workbench: ['generate_shots', 'agent_turn', 'derive_camera', 'generate_element_reference'],
  image_prompts: ['write_image_prompts', 'generate_image', 'agent_turn'],
  storyboard: ['generate_image', 'voiceover', 'background_music', 'agent_turn'],
  video_prompts: ['write_video_prompts'],
  generation: ['generate_clip'],
  assembly: ['merge'],
}

// User-facing labels only - users must never see a raw step/operation
// value or a provider/model name. Every pair listed in STEP_OPERATIONS
// must have an entry here.
const STEP_LABELS: Record<Step, string> = {
  workbench: 'Workbench',
  image_prompts: 'Image Prompts',
  storyboard: 'Storyboard',
  video_prompts: 'Video Prompts',
  generation: 'Generation',
  assembly: 'Assembly',
}

const OPERATION_LABELS: Record<Step, Partial<Record<Operation, string>>> = {
  workbench: {
    generate_shots: 'New shots',
    agent_turn: 'Agent turn',
    derive_camera: 'Camera framing',
    generate_element_reference: 'Element reference image',
  },
  image_prompts: { write_image_prompts: 'Prompt writing', generate_image: 'Image generation', agent_turn: 'Agent turn' },
  storyboard: {
    generate_image: 'Image generation',
    voiceover: 'Voiceover',
    background_music: 'Background music',
    agent_turn: 'Agent turn',
  },
  video_prompts: { write_video_prompts: 'Prompt writing' },
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

// The step half of stepOperationLabel, standalone - for a grouped-by-step view (the
// credits page) that needs a step-level heading separate from each operation row.
export function stepLabel(step: Step): string {
  return STEP_LABELS[step] ?? step
}

// Position of `step` in the project's overall progress scale, where intake
// occupies the conceptual first slot (1) without being a member of Step -
// see CLAUDE.md: intake is a pre-project screen, never a tracked step. This
// keeps stepIndex('workbench') === 2, matching both the furthest_step values
// already backfilled by migration 20260826162156_step_progress.sql and the
// literal `furthest_step: 2` written at project creation
// (src/app/(app)/projects/new/actions.ts). STEPS covers every current_step
// value, so this maps the whole 7-step scale: workbench=2 ... assembly=7.
export function stepIndex(step: Step): number {
  return STEPS.indexOf(step) + 2
}
