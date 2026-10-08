'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { Step } from '@/lib/config/pipeline'

// Client-side navigation to one of a project's step routes - push only. The router itself
// never leaves this hook, so a page that must never refresh (the Storyboard reads image
// state only from its status endpoint) can navigate on without holding router.refresh().
export function useGoToStep(): (projectId: string, step: Step) => void {
  const router = useRouter()
  return useCallback((projectId: string, step: Step) => router.push(`/projects/${projectId}/${step}`), [router])
}
