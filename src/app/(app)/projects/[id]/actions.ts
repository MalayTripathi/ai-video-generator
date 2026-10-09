'use server'

import { createClient } from '@/lib/supabase/server'
import { applyProjectSettings, previewSettingsTrims, type ApplySettingsResult, type ShotTrim } from '@/lib/projects/settings'

export async function updateProjectTitle(projectId: string, title: string) {
  const trimmed = title.trim()
  if (!trimmed) return { error: null }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase
    .from('projects')
    .update({ title: trimmed })
    .eq('id', projectId)
    .eq('user_id', user.id)

  return { error: error?.message ?? null }
}

// The project settings drawer. Both return plain results, never throw to the client.
export async function previewProjectSettingsTrims(
  projectId: string,
  videoModel: string
): Promise<{ trims: ShotTrim[] | null; error: string | null }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { trims: null, error: 'Not authenticated' }
  try {
    return { trims: await previewSettingsTrims(supabase, user.id, projectId, videoModel), error: null }
  } catch (error) {
    console.error('[settings] preview failed', projectId, error)
    return { trims: null, error: 'Could not check shot lengths. Try again.' }
  }
}

export async function saveProjectSettings(
  projectId: string,
  settings: { preset: string; videoModel: string; videoResolution: string; imageQuality: string },
  confirmedTrimCount: number
): Promise<ApplySettingsResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not_found', message: 'Not authenticated' }
  try {
    return await applyProjectSettings(supabase, user.id, projectId, settings, confirmedTrimCount)
  } catch (error) {
    console.error('[settings] apply failed', projectId, error)
    return { ok: false, error: 'write_failed', message: 'Could not save settings. Try again.' }
  }
}
