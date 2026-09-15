'use client'

import { useEffect, useRef } from 'react'

// Refresh ~5 minutes ahead of the batch of signed URLs' one-hour expiry (Task 3's
// getProjectElements), so a card's image never actually goes stale while the tab is
// open. If `expiresAt` is already inside that window (or in the past), refreshes
// immediately. Re-arms itself after each successful refresh via the effect's own
// dependency on `expiresAt`, which `refresh` updates.
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000

export function useSignedUrlRefresh(expiresAt: string, refresh: () => void | Promise<void>) {
  const refreshRef = useRef(refresh)

  // Keeps the ref pointing at the latest `refresh` without making it an effect
  // dependency below - refs must be written in an effect (or an event handler), never
  // during render.
  useEffect(() => {
    refreshRef.current = refresh
  })

  useEffect(() => {
    const msUntilExpiry = new Date(expiresAt).getTime() - Date.now()
    const delay = Math.max(0, msUntilExpiry - REFRESH_BEFORE_EXPIRY_MS)

    const timer = setTimeout(() => {
      void refreshRef.current()
    }, delay)

    return () => clearTimeout(timer)
  }, [expiresAt])
}
