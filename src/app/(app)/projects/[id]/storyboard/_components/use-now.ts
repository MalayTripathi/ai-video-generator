'use client'

import { useEffect, useState } from 'react'

// The current time for ETAs, ticking once a second while `active`. Null until mounted, so
// the server render and the client's first render agree (no hydration mismatch); callers
// treat null as "no elapsed time yet".
export function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    if (!active) return () => clearTimeout(first)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}
