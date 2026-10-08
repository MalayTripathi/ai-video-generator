'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import { assertRegisteredVideoModel, DEFAULT_QUALITY_PRESET, QUALITY_PRESETS } from '@/lib/config/models'
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

  const durationTargetRaw = formData.get('duration_target') as string | null
  const durationTarget: DurationTarget =
    durationTargetRaw && durationTargetRaw in durationConfig ? (durationTargetRaw as DurationTarget) : '1-2min'

  const language = (formData.get('language') as string | null)?.trim() || 'en'
  // Until intake offers a quality choice, every new project takes the default preset - a
  // template's own model is not carried over. The model is checked against the registry
  // before it is written: an unknown value fails loudly, never lands in the row.
  const preset = QUALITY_PRESETS[DEFAULT_QUALITY_PRESET]
  const videoModel = assertRegisteredVideoModel(preset.videoModel)
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
      quality_preset: DEFAULT_QUALITY_PRESET,
      video_model: videoModel,
      video_resolution: preset.videoResolution,
      image_quality: preset.imageQuality,
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
