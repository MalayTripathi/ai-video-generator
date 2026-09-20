'use client'

import { createContext } from 'react'

// How a step's cards are locked while an agent turn writes to them. The panel is one
// component for every step and cannot import a step's own provider, so a step that wants
// its cards locked provides this instead. The Workbench provides its own lock functions
// through its ShotsContext and does not use it.
export type AgentLocks = {
  lockShot: (shotKey: string) => void
  unlockAllShots: () => void
}

export const AgentLocksContext = createContext<AgentLocks | null>(null)
