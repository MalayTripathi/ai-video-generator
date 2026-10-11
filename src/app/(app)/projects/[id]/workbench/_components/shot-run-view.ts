// What the Workbench shows about the latest shot run: the generating state's progress
// line, why a run stopped, and whether "Generate remaining shots" applies. Pure - the page
// builds it from its reads and the shots list renders it.

export type ShotRunView = {
  status: 'running' | 'completed' | 'stopped' | 'failed' | null
  stopReason: string | null
  /** Null until the run's scene plan exists. */
  totalScenes: number | null
  writtenScenes: number
  unwrittenScenes: number
}

export function shotRunView(
  run: { status: string; stop_reason: string | null; total_scenes: number | null } | null,
  scenes: readonly { shot_run_chunks: readonly { scene_complete: boolean }[] }[]
): ShotRunView {
  const written = scenes.filter((s) => s.shot_run_chunks.some((c) => c.scene_complete)).length
  return {
    status: (run?.status as ShotRunView['status']) ?? null,
    stopReason: run?.stop_reason ?? null,
    totalScenes: run?.total_scenes ?? null,
    writtenScenes: written,
    unwrittenScenes: scenes.length - written,
  }
}

/** The generating state's progress line. */
export function shotRunProgressLine(view: ShotRunView): string {
  if (view.status !== 'running' || view.totalScenes === null) return 'Planning the scenes from your brief.'
  const current = Math.min(view.totalScenes, view.writtenScenes + 1)
  return `Writing scene ${current} of ${view.totalScenes}`
}

/**
 * Whenever no run is going and the scene plan has scenes not yet written - unwritten, or
 * started and not finished - "Generate remaining shots" writes exactly those, whatever the
 * last run ended as.
 */
export function canGenerateRemaining(view: ShotRunView): boolean {
  return view.status !== null && view.status !== 'running' && view.totalScenes !== null && view.unwrittenScenes > 0
}
