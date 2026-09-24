'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export type RailFigures = { spendThisMonth: number; creditsSpentThisMonth: number }

type RailFiguresValue = { figures: RailFigures; setFigures: (next: RailFigures) => void }

const RailFiguresContext = createContext<RailFiguresValue | null>(null)

export function useRailFigures(): RailFiguresValue {
  const ctx = useContext(RailFiguresContext)
  if (!ctx) throw new Error('useRailFigures must be used inside RailFiguresProvider')
  return ctx
}

// Narrows an untrusted response field to a figures pair, or null.
export function parseRailFigures(value: unknown): RailFigures | null {
  const v = value as Partial<RailFigures> | null | undefined
  if (typeof v?.spendThisMonth !== 'number' || typeof v?.creditsSpentThisMonth !== 'number') return null
  return { spendThisMonth: v.spendThisMonth, creditsSpentThisMonth: v.creditsSpentThisMonth }
}

// The rail's spend figures as client state, seeded by the layout's server read. A paid
// action updates them from its own response via setFigures. A fresh server seed (a
// router.refresh() on a step that still relies on one) replaces the client value, so both
// paths converge.
export function RailFiguresProvider({ initial, children }: { initial: RailFigures; children: ReactNode }) {
  const [figures, setFigures] = useState(initial)
  const [seen, setSeen] = useState(initial)
  if (seen.spendThisMonth !== initial.spendThisMonth || seen.creditsSpentThisMonth !== initial.creditsSpentThisMonth) {
    setSeen(initial)
    setFigures(initial)
  }
  const value = useMemo(() => ({ figures, setFigures }), [figures])
  return <RailFiguresContext.Provider value={value}>{children}</RailFiguresContext.Provider>
}
