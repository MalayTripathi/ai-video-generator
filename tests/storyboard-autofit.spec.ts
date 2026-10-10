import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { stepIndex } from '../src/lib/config/pipeline'
import { autoFitAfterVoiceover } from '../src/lib/storyboard/apply-fit'
import { isRefitPending } from '../src/app/api/projects/[id]/images/status/logic'
import { saveFilmDurationForUser } from '../src/app/(app)/projects/[id]/storyboard/actions'

// Fit to voiceover after a voiceover is saved (decision 17): the first read is fitted
// automatically and free; a regenerated read refits silently unless shots were retimed by
// hand since the last fit - then the Storyboard asks "Refit timing?" first.

const shotKey = () => Array.from({ length: 5 }, () => '23456789bcdfghjkmnpqrstvwxz'[Math.floor(Math.random() * 27)]).join('')

async function seed(): Promise<{ projectId: string; ids: string[] }> {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Auto-fit',
      source_text: 'x',
      video_type: 'explainer',
      duration_target: '30-60s',
      video_model: 'wan-3.0',
      current_step: 'storyboard',
      furthest_step: stepIndex('storyboard'),
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id
  const narration = ['First line here.', '', 'Third line here.']
  const { data: shots } = await admin
    .from('shots')
    .insert(
      narration.map((voice_over, i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: shotKey(),
        voice_over,
        visual_description: `Shot ${i + 1}`,
        duration_sec: 4,
      }))
    )
    .select('id, order_index')
  const ids = shots!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id)
  return { projectId, ids }
}

// A read: shot 0 speaks 0-1.6s, shot 1 is silent, shot 2 speaks 1.7-4.4s.
async function linkRead(projectId: string, ids: string[], generatedAt: string) {
  const spans = [
    { shotId: ids[0], from: 0, to: 16, text: 'First line here.', startSec: 0, endSec: 1.6 },
    { shotId: ids[1], from: 17, to: 17, text: '', startSec: 1.6, endSec: 1.6 },
    { shotId: ids[2], from: 17, to: 33, text: 'Third line here.', startSec: 1.7, endSec: 4.4 },
  ]
  await admin
    .from('projects')
    .update({
      audio_path: `${primary.user.id}/${projectId}/voiceover/read.mp3`,
      voiceover_alignment_path: `${primary.user.id}/${projectId}/voiceover/read.json`,
      voiceover_source: 'generated',
      voiceover_generated_at: generatedAt,
      total_duration_sec: 4.4,
      voiceover_spans: spans as never,
    })
    .eq('id', projectId)
}

async function lengths(projectId: string) {
  const { data } = await admin.from('shots').select('film_duration_sec, order_index').eq('project_id', projectId).order('order_index')
  return (data ?? []).map((s) => s.film_duration_sec)
}

async function stamps(projectId: string) {
  const { data } = await admin
    .from('projects')
    .select('last_fit_at, last_manual_retime_at, voiceover_generated_at')
    .eq('id', projectId)
    .single()
  return data!
}

test.describe('auto-fit after a voiceover', () => {
  test('the first voiceover is fitted automatically: narrated shots to span + padding (whole seconds), the silent shot keeps its length', async () => {
    const { projectId, ids } = await seed()
    await linkRead(projectId, ids, new Date().toISOString())
    await autoFitAfterVoiceover(admin, projectId)
    // 1.6 + 0.25 -> 2; silent keeps 4 (no write); 2.7 + 0.25 -> 3.
    expect(await lengths(projectId)).toEqual([2, null, 3])
    expect((await stamps(projectId)).last_fit_at).not.toBeNull()
  })

  test('a regenerated voiceover refits silently when nothing was retimed by hand since the last fit', async () => {
    const { projectId, ids } = await seed()
    await linkRead(projectId, ids, new Date(Date.now() - 60_000).toISOString())
    await autoFitAfterVoiceover(admin, projectId)
    // Someone nudges a length through the fit's own write path, not by hand: still auto.
    await admin.from('shots').update({ film_duration_sec: 9 }).eq('id', ids[0])
    await linkRead(projectId, ids, new Date().toISOString())
    await autoFitAfterVoiceover(admin, projectId)
    expect((await lengths(projectId))[0]).toBe(2)
    expect(isRefitPending(await stamps(projectId))).toBe(false)
  })

  test('after a manual retime, a regenerated voiceover is not refitted - the Storyboard asks first', async () => {
    const { projectId, ids } = await seed()
    await linkRead(projectId, ids, new Date(Date.now() - 120_000).toISOString())
    await autoFitAfterVoiceover(admin, projectId)
    const retime = await saveFilmDurationForUser(admin, primary.user.id, projectId, ids[0], 6)
    expect(retime.success).toBe(true)
    // The retime range is the project's video model's (Wan 3.0: 2-30s).
    expect((await saveFilmDurationForUser(admin, primary.user.id, projectId, ids[0], 1)).success).toBe(false)

    await linkRead(projectId, ids, new Date(Date.now() + 1_000).toISOString())
    await autoFitAfterVoiceover(admin, projectId)
    expect((await lengths(projectId))[0]).toBe(6) // the hand retime stands
    expect(isRefitPending(await stamps(projectId))).toBe(true)
  })
})
