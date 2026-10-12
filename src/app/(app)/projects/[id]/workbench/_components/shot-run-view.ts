// What the Workbench shows about the latest shot run: the generating state's progress
// line, why a run stopped, and whether "Generate remaining shots" applies. Pure - the page
// builds it from its reads and the shots list renders it.

export type ShotRunView = {
  /** The run's id - a status read is matched to the run a start returned. */
  id: string | null
  status: 'running' | 'completed' | 'stopped' | 'failed' | null
  stopReason: string | null
  /** Null until the run's scene plan exists. */
  totalScenes: number | null
  writtenScenes: number
  unwrittenScenes: number
  /** A settled run's hold and actual charge (credits) - null until it is settled. */
  held: number | null
  charged: number | null
}

export function shotRunView(
  run: { id?: string; status: string; stop_reason: string | null; total_scenes: number | null; charged_at?: string | null } | null,
  scenes: readonly { shot_run_chunks: readonly { scene_complete: boolean }[] }[],
  charge: { held: number | null; charged: number | null } = { held: null, charged: null }
): ShotRunView {
  const written = scenes.filter((s) => s.shot_run_chunks.some((c) => c.scene_complete)).length
  const settled = run?.charged_at != null
  return {
    id: run?.id ?? null,
    status: (run?.status as ShotRunView['status']) ?? null,
    stopReason: run?.stop_reason ?? null,
    totalScenes: run?.total_scenes ?? null,
    writtenScenes: written,
    unwrittenScenes: scenes.length - written,
    held: settled ? charge.held : null,
    charged: settled ? charge.charged : null,
  }
}

/** Whether two views show the same thing - a status check that changes nothing sets nothing. */
export function sameShotRunView(a: ShotRunView, b: ShotRunView): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.stopReason === b.stopReason &&
    a.totalScenes === b.totalScenes &&
    a.writtenScenes === b.writtenScenes &&
    a.unwrittenScenes === b.unwrittenScenes &&
    a.held === b.held &&
    a.charged === b.charged
  )
}

/** A settled run's hold and charge, as the run end shows them ("80 held · 62 charged"). */
export function shotRunChargeLine(view: ShotRunView): string | null {
  if (view.held === null || view.charged === null) return null
  return `${view.held.toLocaleString('en-US')} held · ${view.charged.toLocaleString('en-US')} charged`
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

export type SceneProgress = { targetSeconds: number; writtenSeconds: number; complete: boolean }

/** Folds a scene read (its chunks' completion and its shots' seconds) into its progress. */
export function sceneProgress(row: {
  target_seconds: number | null
  shot_run_chunks: { scene_complete: boolean }[]
  shots: { duration_sec: number | null }[]
}): SceneProgress {
  return {
    targetSeconds: Number(row.target_seconds ?? 0),
    writtenSeconds: row.shots.reduce((sum, s) => sum + Number(s.duration_sec ?? 0), 0),
    complete: row.shot_run_chunks.some((c) => c.scene_complete),
  }
}
