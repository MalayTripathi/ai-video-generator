import type { ElementType } from '@/lib/config/enums'

// Display-only copy for the Assets tab's four element groups. Mirrors
// camera-labels.ts's pattern: the stored `type` values, the DB CHECK constraint, and
// the write_shots tool schema are untouched - this only changes what a person reads.
// Canvas: "12 - Step 2 - Assets tab" (12A/12B group header rows).

export const ELEMENT_TYPE_LABELS: Record<ElementType, string> = {
  character: 'Characters',
  location: 'Locations',
  prop: 'Props',
  style: 'Style',
}

export const ELEMENT_TYPE_SINGULAR_LABELS: Record<ElementType, string> = {
  character: 'character',
  location: 'location',
  prop: 'prop',
  style: 'style',
}

export const ELEMENT_TYPE_DESCRIPTIONS: Record<ElementType, string> = {
  character: 'People and creatures that must look the same across shots.',
  location: 'Places that recur. One reference keeps them consistent.',
  prop: 'Objects that appear in more than one shot.',
  style: 'Applied to every image prompt in the project.',
}

// The per-type dot colour shown next to every card's name, matching canvas 12A/12B
// exactly (character: accent, location: status-done-fg, prop: status-active-fg,
// style: accent-quiet).
export const ELEMENT_TYPE_DOT_CLASSNAME: Record<ElementType, string> = {
  character: 'bg-accent',
  location: 'bg-status-done-fg',
  prop: 'bg-status-active-fg',
  style: 'bg-accent-quiet',
}
