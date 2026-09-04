import type Anthropic from '@anthropic-ai/sdk'
import { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, MODEL_REPORTABLE_CAMERA_ORIGINS } from '@/lib/config/enums'

export type CameraFieldName = 'shot_size' | 'camera_angle' | 'camera_movement'

export const CAMERA_FIELD_NAMES: readonly CameraFieldName[] = ['shot_size', 'camera_angle', 'camera_movement']

// Exported so the route's write-back validation (which field values Claude is allowed
// to have returned) can reuse the exact same mapping the schema itself was built from,
// rather than a second hand-maintained copy.
export const CAMERA_FIELD_ENUM: Record<CameraFieldName, readonly string[]> = {
  shot_size: SHOT_SIZES,
  camera_angle: CAMERA_ANGLES,
  camera_movement: CAMERA_MOVEMENTS,
}

export const CAMERA_DERIVATION_SYSTEM_PROMPT = `You are reading a single shot's visual description and reporting its camera framing via the derive_camera tool.

For each requested field, report:
- the best-judgment camera value from its enum
- '<field>_origin': 'derived' only when the visual description explicitly names that specific choice (e.g. "wide shot" names shot_size); otherwise 'auto'. Never infer 'derived' from tone or implication - only an explicit textual match counts.

Call derive_camera exactly once.`

// Parameterized like buildWriteShotsTool(targetShots) in shot-generation.ts - one
// schema-construction path serves both the always-3-fields call fired by a
// visual_description edit and a "Revert to auto" call for a single field, rather than
// two divergent builders.
export function buildDeriveCameraTool(fields: CameraFieldName[]): Anthropic.Tool {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const field of fields) {
    properties[field] = { type: 'string', enum: [...CAMERA_FIELD_ENUM[field]] }
    properties[`${field}_origin`] = {
      type: 'string',
      description: `'derived' only when the visual description explicitly names this ${field.replace('_', ' ')}; otherwise 'auto'.`,
      // Structurally excludes 'override' - the same guarantee write_shots' tool schema
      // uses (see MODEL_REPORTABLE_CAMERA_ORIGINS in enums.ts). Only a manual edit sets
      // 'override'; the model can never return it.
      enum: [...MODEL_REPORTABLE_CAMERA_ORIGINS],
    }
    required.push(field, `${field}_origin`)
  }

  return {
    name: 'derive_camera',
    description: 'Report the camera framing for the requested field(s) and whether each was explicitly named in the visual description.',
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    strict: true,
    // No cache_control: unlike write_shots/write_prompts' large, stable, reused system
    // prompts, this schema is tiny and its field set varies per call (1 vs 3 fields) -
    // not worth an ephemeral cache write for a payload this small.
  }
}

export function buildCameraDynamicBlock(visualDescription: string): string {
  return `Visual description:\n${visualDescription}\n\nReport the requested camera field(s) now.`
}
