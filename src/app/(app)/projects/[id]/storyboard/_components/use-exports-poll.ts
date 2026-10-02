'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePageVisible } from '@/lib/hooks/use-page-visible'
import type { ExportsData } from '@/app/api/projects/[id]/exports/logic'

// Polls the export history only while an export is queued or rendering, at the interval
// the endpoint names, and stops the moment none is - or while the tab is hidden, polling
// once on return. `refresh()` fetches at once - every
// export action calls it, which also restarts the chain. Client state only: nothing here
// touches the router. Only the newest request's answer is ever applied.
export function useExportsPoll(projectId: string, initial: ExportsData) {
  const [data, setData] = useState(initial)
  const latestRequest = useRef(0)
  const [failures, setFailures] = useState(0)

  const refresh = useCallback(async () => {
    const requestNo = ++latestRequest.current
    try {
      const res = await fetch(`/api/projects/${projectId}/exports`, { cache: 'no-store' })
      const body = await res.json().catch(() => null)
      if (requestNo !== latestRequest.current) return
      if (!res.ok || !body?.ok) {
        setFailures((n) => n + 1)
        return
      }
      setData({ rows: body.rows, pollIntervalMs: body.pollIntervalMs })
    } catch {
      if (requestNo === latestRequest.current) setFailures((n) => n + 1)
    }
  }, [projectId])

  const active = data.rows.some((row) => row.status === 'queued' || row.status === 'rendering')
  const visible = usePageVisible(() => {
    if (active) void refresh()
  })
  useEffect(() => {
    if (!active || !visible) return
    const timer = setTimeout(() => void refresh(), data.pollIntervalMs)
    return () => clearTimeout(timer)
  }, [active, visible, data, failures, refresh])

  return { data, active, refresh }
}
