// Single source of truth for shot-attribute and project-setting enums whose domains are
// mirrored by hand into DB CHECK constraints (see supabase/migrations/*.sql) and, for
// video_type/shot_size/camera_angle/camera_movement, into the write_shots tool schema
// (src/lib/prompts/shot-generation.ts). Source of truth is this hand-written TS const for
// every enum here, uniformly - never derived from database.types.ts, since a
// CHECK-constrained text column is typed as plain `string` by the Supabase codegen, so
// derivation isn't available for some of these and mixing derived/hand-written would mean
// two patterns for one job.
//
// This is a different axis from pipeline.ts: pipeline.ts describes the pipeline itself
// (steps/operations/providers); this file describes shot attributes and project settings.
// Keep them separate.

export const VIDEO_TYPES = [
  'auto',
  'narrated_story',
  'explainer',
  'facts_listicle',
  'character_drama',
  'product_ad',
  'trailer',
] as const

export type VideoType = (typeof VIDEO_TYPES)[number]

// Claude's write_shots classification never returns 'auto' - that value only exists for
// the intake screen's "detect from my text" option. Derived from VIDEO_TYPES rather than
// hand-duplicated so it can't drift.
export const CLASSIFIABLE_VIDEO_TYPES = VIDEO_TYPES.filter(
  (v): v is Exclude<VideoType, 'auto'> => v !== 'auto'
)

export const ASPECT_RATIOS = ['9:16', '16:9', '1:1'] as const

export type AspectRatio = (typeof ASPECT_RATIOS)[number]

export const SHOT_SIZES = ['wide', 'full', 'medium', 'close_up', 'extreme_close_up'] as const

export type ShotSize = (typeof SHOT_SIZES)[number]

export const CAMERA_ANGLES = ['eye_level', 'low', 'high', 'over_the_shoulder', 'top_down'] as const

export type CameraAngle = (typeof CAMERA_ANGLES)[number]

export const CAMERA_MOVEMENTS = [
  'static',
  'slow_push_in',
  'pull_out',
  'pan',
  'tilt',
  'orbit',
  'handheld',
] as const

export type CameraMovement = (typeof CAMERA_MOVEMENTS)[number]

// Duplicated the same way as the enums above (tool schema + sanitizeEnum) but has no DB
// CHECK constraint on elements.type - consolidated here for consistency; excluded from
// the enum drift test since there's no DB rejection to assert against.
export const ELEMENT_TYPES = ['character', 'location', 'prop'] as const

export type ElementType = (typeof ELEMENT_TYPES)[number]
