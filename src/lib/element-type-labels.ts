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

// Identity-family classes (canvas section 13): the 5px dot and the chip tint for an
// element's type. Literal class strings so Tailwind can see them. The Assets tab still
// reads ELEMENT_TYPE_DOT_CLASSNAME above until the separate retrofit pass.
export const ELEMENT_TYPE_IDENT_CLASSNAMES: Record<ElementType, { dot: string; chip: string }> = {
  character: { dot: 'bg-ident-character-fg', chip: 'bg-ident-character-bg text-ident-character-fg' },
  location: { dot: 'bg-ident-location-fg', chip: 'bg-ident-location-bg text-ident-location-fg' },
  prop: { dot: 'bg-ident-prop-fg', chip: 'bg-ident-prop-bg text-ident-prop-fg' },
  style: { dot: 'bg-ident-style-fg', chip: 'bg-ident-style-bg text-ident-style-fg' },
}

// elements.type has no DB CHECK yet (see docs/roadmap.md), so an unrecognised value falls
// back to the neutral dot rather than crashing a render.
export function identDotClassName(type: string): string {
  return ELEMENT_TYPE_IDENT_CLASSNAMES[type as ElementType]?.dot ?? 'bg-border-strong'
}
