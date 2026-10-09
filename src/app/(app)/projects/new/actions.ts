'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { parseDurationTarget } from '@/lib/config/duration'
import { assertRegisteredVideoModel } from '@/lib/config/models'
import { parseQualitySettings } from '@/lib/quality/estimate'
import { VIDEO_TYPES, ASPECT_RATIOS } from '@/lib/config/enums'

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
  const videoType =
    videoTypeRaw && (VIDEO_TYPES as readonly string[]).includes(videoTypeRaw) ? videoTypeRaw : 'auto'

  const aspectRatioRaw = formData.get('aspect_ratio') as string | null
  const aspectRatio =
    aspectRatioRaw && (ASPECT_RATIOS as readonly string[]).includes(aspectRatioRaw) ? aspectRatioRaw : '9:16'

  const durationTarget = parseDurationTarget(formData.get('duration_target') as string | null)

  const language = (formData.get('language') as string | null)?.trim() || 'en'
  // The Quality group's five values. An unsupported model/resolution/quality combination,
  // or a named preset whose values don't match it, is refused - never coerced. The model is
  // checked against the registry again before it is written.
  const quality = parseQualitySettings({
    preset: formData.get('quality_preset'),
    videoModel: formData.get('video_model'),
    videoResolution: formData.get('video_resolution'),
    imageQuality: formData.get('image_quality'),
    imageModel: formData.get('image_model'),
  })
  const videoModel = assertRegisteredVideoModel(quality.videoModel)
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
      quality_preset: quality.preset,
      video_model: videoModel,
      video_resolution: quality.videoResolution,
      image_quality: quality.imageQuality,
      image_model: quality.imageModel,
      template_source_id: templateSourceId,
      status: 'draft',
      current_step: 'workbench',
      furthest_step: 2,
    })
    .select('id')
    .single()

  if (error || !project) {
    throw new Error(error?.message ?? 'Failed to create project')
  }

  redirect(`/projects/${project.id}/workbench`)
}
