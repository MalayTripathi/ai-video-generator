'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import { modelsConfig } from '@/lib/config/models'

const VIDEO_TYPES = [
  'auto',
  'narrated_story',
  'explainer',
  'facts_listicle',
  'character_drama',
  'product_ad',
  'trailer',
]
const ASPECT_RATIOS = ['9:16', '16:9', '1:1']

export async function createProjectFromIntake(formData: FormData) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const sourceText = (formData.get('source_text') as string | null)?.trim()
  if (!sourceText) {
    throw new Error('Describe what you want to make first.')
  }

  const videoTypeRaw = formData.get('video_type') as string | null
  const videoType = videoTypeRaw && VIDEO_TYPES.includes(videoTypeRaw) ? videoTypeRaw : 'auto'

  const aspectRatioRaw = formData.get('aspect_ratio') as string | null
  const aspectRatio = aspectRatioRaw && ASPECT_RATIOS.includes(aspectRatioRaw) ? aspectRatioRaw : '9:16'

  const durationTargetRaw = formData.get('duration_target') as string | null
  const durationTarget: DurationTarget =
    durationTargetRaw && durationTargetRaw in durationConfig ? (durationTargetRaw as DurationTarget) : '1-2min'

  const language = (formData.get('language') as string | null)?.trim() || 'en'
  const videoModel = (formData.get('video_model') as string | null)?.trim() || modelsConfig.video.model
  const templateSourceId = (formData.get('template_source_id') as string | null)?.trim() || null

  const { data: project, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      title: null,
      source_text: sourceText,
      video_type: videoType,
      aspect_ratio: aspectRatio,
      duration_target: durationTarget,
      language,
      video_model: videoModel,
      template_source_id: templateSourceId,
      status: 'draft',
      current_step: 'workbench',
      furthest_step: 2,
      shots_generation: 'pending',
    })
    .select('id')
    .single()

  if (error || !project) {
    throw new Error(error?.message ?? 'Failed to create project')
  }

  redirect(`/projects/${project.id}/workbench`)
}
