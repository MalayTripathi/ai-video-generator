'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'

// Whether this tab is visible. Every client poll loop gates on it: a hidden tab stops
// asking (server-side work carries on regardless), and `onResume` fires once on the
// hidden -> visible transition so the loop polls at once instead of waiting a full
// interval. `onResume` is held in a ref, so callers pass a fresh closure every render
// without it ever becoming an effect dependency.

function subscribe(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

const getSnapshot = () => document.visibilityState !== 'hidden'
const getServerSnapshot = () => true

export function usePageVisible(onResume?: () => void): boolean {
  const visible = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const onResumeRef = useRef(onResume)
  useEffect(() => {
    onResumeRef.current = onResume
  })
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) onResumeRef.current?.()
    wasVisible.current = visible
  }, [visible])
  return visible
}
