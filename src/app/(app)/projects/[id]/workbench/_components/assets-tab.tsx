'use client'

import { ElementGroup } from './element-group'
import { useShots } from './shots-context'

export const REFERENCE_IMAGES_NOTE =
  'Reference images are optional. Without one, an element is written into the image prompt from its description — that works fine. A reference just holds the look steadier across shots.'

// Canvas: "12 - Step 2 - Assets tab" (12A/12B). Four groups in order - characters,
// locations, props, style - each a full-width section over its own 4-column card grid.
// Creating and editing happen inline, in the grid itself; see element-group.tsx and
// element-card.tsx. Past the Storyboard the Shots tab states the lock, and the reference
// note moves into the footer (workbench-footer.tsx).
export function AssetsTab() {
  const { readOnly } = useShots()
  return (
    <div className="flex flex-col gap-rc-md">
      {!readOnly && (
        <div className="flex gap-rc-xs rounded-control bg-bg-inset p-[9px_12px]">
          <span className="flex-none pt-[1px] text-text-tertiary">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
              <path d="M7 6.2v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="7" cy="4.1" r="0.75" fill="currentColor" />
            </svg>
          </span>
          <span className="text-small leading-[1.5] text-text-secondary">{REFERENCE_IMAGES_NOTE}</span>
        </div>
      )}

      <ElementGroup type="character" />
      <ElementGroup type="location" />
      <ElementGroup type="prop" />
      <ElementGroup type="style" />
    </div>
  )
}
