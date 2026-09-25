'use server'

import { createClient } from '@/lib/supabase/server'
import { stepIndex } from '@/lib/config/pipeline'
import { resolveVideoModel, videoModelMaxSeconds } from '@/lib/config/models'
import { filmDuration, isRetimeAllowed, retimeBounds } from '@/lib/storyboard/timeline'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// Storyboard timeline edits: retime, reorder, bin. Each is free, marks nothing stale, and
// writes only the Storyboard's own columns (film_order, film_duration_sec, binned_at) -
// never order_index or duration_sec, which belong to the script. Plain result objects,
// never thrown; ownership through the projects join, RLS as the backstop. Never calls
// advanceStep - saving is not advancing.
export type TimelineEditResult = { success: true; unchanged?: true } | { success: false; error: string }

type EditableProject = { id: string; video_model: string | null }

// The project, if this user owns it and its Storyboard is still editable (the edit-lock
// closes once the next step has started, as the page's readOnly does).
async function editableProject(
  supabase: SupabaseServerClient,
  projectId: string,
  userId: string
): Promise<EditableProject | { error: string }> {
  const { data: project } = await supabase
    .from('projects')
    .select('id, video_model, furthest_step')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!project) return { error: 'Project not found' }
  if (project.furthest_step >= stepIndex('video_prompts')) return { error: 'The storyboard is locked' }
  return { id: project.id, video_model: project.video_model }
}

// resolveVideoModel throws outside production for an unregistered model (a missing
// registry entry should fail loudly) and is null in production - retime is then refused.
function modelMaxSeconds(videoModel: string | null): number | null {
  const config = resolveVideoModel(videoModel)
  return config ? videoModelMaxSeconds(config) : null
}

export async function saveFilmDurationForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  shotId: string,
  seconds: number
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, duration_sec, film_duration_sec, projects!inner(user_id)')
    .eq('id', shotId)
    .eq('project_id', projectId)
    .eq('projects.user_id', userId)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }

  const committed = filmDuration(shot)
  const bounds = retimeBounds(modelMaxSeconds(project.video_model), committed)
  if (!bounds) return { success: false, error: 'Retime is unavailable for this video model' }
  if (!isRetimeAllowed(seconds, bounds)) return { success: false, error: 'That length is outside what this model allows' }
  if (seconds === committed) return { success: true, unchanged: true }

  const { error } = await supabase
    .from('shots')
    .update({ film_duration_sec: seconds, updated_at: new Date().toISOString() })
    .eq('id', shotId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function saveFilmOrderForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  writes: { id: string; film_order: number }[]
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }
  if (writes.length === 0) return { success: true, unchanged: true }
  if (!writes.every((w) => Number.isInteger(w.film_order) && w.film_order >= 0)) {
    return { success: false, error: 'Invalid order' }
  }

  const { data: shots } = await supabase
    .from('shots')
    .select('id, film_order')
    .eq('project_id', projectId)
    .in(
      'id',
      writes.map((w) => w.id)
    )
  if (!shots || shots.length !== new Set(writes.map((w) => w.id)).size) return { success: false, error: 'Shot not found' }

  const current = new Map(shots.map((s) => [s.id, s.film_order]))
  const updatedAt = new Date().toISOString()
  // A plain per-row loop - no RPC. Each write is independent; last write wins.
  for (const w of writes) {
    if (current.get(w.id) === w.film_order) continue
    const { error } = await supabase
      .from('shots')
      .update({ film_order: w.film_order, updated_at: updatedAt })
      .eq('id', w.id)
      .eq('project_id', projectId)
    if (error) return { success: false, error: error.message }
  }
  return { success: true }
}

export async function restoreScriptOrderForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string
): Promise<TimelineEditResult> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }

  const { error } = await supabase
    .from('shots')
    .update({ film_order: null, updated_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .not('film_order', 'is', null)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// Remove sets binned_at; Restore clears it. The image and film_order are kept, so a
// restored shot returns to the slot it left.
export async function setShotBinnedForUser(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  shotId: string,
  binned: boolean
): Promise<TimelineEditResult & { binnedAt?: string | null }> {
  const project = await editableProject(supabase, projectId, userId)
  if ('error' in project) return { success: false, error: project.error }

  const { data: shot } = await supabase
    .from('shots')
    .select('id, binned_at')
    .eq('id', shotId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (!shot) return { success: false, error: 'Shot not found' }
  if ((shot.binned_at !== null) === binned) return { success: true, unchanged: true, binnedAt: shot.binned_at }

  const now = new Date().toISOString()
  const binnedAt = binned ? now : null
  const { error } = await supabase.from('shots').update({ binned_at: binnedAt, updated_at: now }).eq('id', shotId)
  if (error) return { success: false, error: error.message }
  return { success: true, binnedAt }
}

async function currentUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { supabase, user }
}

const NOT_AUTHENTICATED = { success: false, error: 'Not authenticated' } as const

export async function saveFilmDuration(projectId: string, shotId: string, seconds: number): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return saveFilmDurationForUser(supabase, user.id, projectId, shotId, seconds)
}

export async function saveFilmOrder(
  projectId: string,
  writes: { id: string; film_order: number }[]
): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return saveFilmOrderForUser(supabase, user.id, projectId, writes)
}

export async function restoreScriptOrder(projectId: string): Promise<TimelineEditResult> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return restoreScriptOrderForUser(supabase, user.id, projectId)
}

export async function setShotBinned(
  projectId: string,
  shotId: string,
  binned: boolean
): Promise<TimelineEditResult & { binnedAt?: string | null }> {
  const { supabase, user } = await currentUser()
  if (!user) return NOT_AUTHENTICATED
  return setShotBinnedForUser(supabase, user.id, projectId, shotId, binned)
}
