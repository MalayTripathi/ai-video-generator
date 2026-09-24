'use client'

import { createContext, useContext, type ReactNode } from 'react'

// Whether a step's own panel currently holds the agent's column (Storyboard's inspect
// panel, canvas 15e). A step's client provider supplies it; every other step leaves the
// default, so the agent always shows there.
export const SideColumnOverrideContext = createContext(false)

// The agent stays MOUNTED while overridden - hidden, not unmounted - so an unsent draft or
// a streaming turn survives a trip into the inspect panel and back.
export function SideColumnSwitch({ agent, override }: { agent: ReactNode; override?: ReactNode }) {
  const overridden = useContext(SideColumnOverrideContext) && override !== undefined
  return (
    <>
      <div className={overridden ? 'hidden' : 'contents'} data-testid="agent-column">
        {agent}
      </div>
      {overridden && override}
    </>
  )
}
