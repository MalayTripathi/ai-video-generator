'use client'

import { ElementGroup } from './element-group'
import { LockIcon } from './lock-icon'
import { useShots } from './shots-context'

// Canvas: "12G Assets live, shots locked" - reached from Step 3's element picker once
// the workbench is otherwise read-only. The lock is per tab, not per screen: this banner
// only ever appears here, never inside Shots' own ReadOnlyBanner (shots-tab.tsx), which
// already states the Shots side of the same fact.
function AssetsLockedBanner() {
  return (
    <div className="flex items-center gap-rc-xs border-b border-border-subtle pb-rc-sm">
      <span className="flex flex-none items-center gap-[5px] rounded-full bg-bg-inset px-[10px] py-[4px] text-chip text-text-secondary">
        <LockIcon />
        Shots view only
      </span>
      <span className="text-small leading-[1.5] text-text-secondary">
        Shots are locked from the storyboard step on. Assets stay editable — anything you
        add here shows up in the element picker.{' '}
        <span className="cursor-not-allowed text-accent">Reopen Step 2</span> to change the
        shots.
      </span>
    </div>
  )
}

// Canvas: "12 - Step 2 - Assets tab" (12A/12B). Four groups in order - characters,
// locations, props, style - each a full-width section over its own 4-column card grid.
// Creating and editing happen inline, in the grid itself; see element-group.tsx and
// element-card.tsx.
export function AssetsTab() {
  const { readOnly } = useShots()
  return (
    <div className="flex flex-col gap-rc-md">
      {readOnly && <AssetsLockedBanner />}
      <div className="flex gap-rc-xs rounded-control bg-bg-inset p-[9px_12px]">
        <span className="flex-none pt-[1px] text-text-tertiary">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7 6.2v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="7" cy="4.1" r="0.75" fill="currentColor" />
          </svg>
        </span>
        <span className="text-small leading-[1.5] text-text-secondary">
          Reference images are optional. Without one, an element is written into the image prompt from its
          description — that works fine. A reference just holds the look steadier across shots.
        </span>
      </div>

      <ElementGroup type="character" />
      <ElementGroup type="location" />
      <ElementGroup type="prop" />
      <ElementGroup type="style" />
    </div>
  )
}
