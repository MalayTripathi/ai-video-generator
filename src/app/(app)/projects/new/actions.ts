'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { parseDurationTarget } from '@/lib/config/duration'
import { assertRegisteredVideoModel } from '@/lib/config/models'
import { parseQualitySettings } from '@/lib/quality/estimate'
import { VIDEO_TYPES, ASPECT_RATIOS } from '@/lib/config/enums'
import { shotGenerationCredits } from '@/lib/config/credits'
import { readBalance } from '@/lib/credits/balance'
import type { IntakeState } from './types'

/**
 * Creates the project, then the Workbench starts writing its shot list. Unless the person
 * chose to create it without writing shots, the balance is checked first: a balance that
 * can't cover the shot list creates nothing and hands back both figures, so the person
 * sees them before anything begins.
 */
export async function createProjectFromIntake(_previous: IntakeState, formData: FormData): Promise<IntakeState> {
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

  if (formData.get('write_shots') !== 'no') {
    const requiredCredits = shotGenerationCredits(durationTarget)
    const { balance } = await readBalance(supabase, user.id, { fresh: true })
    if (balance < requiredCredits) return { shortfall: { requiredCredits, balanceCredits: balance } }
  }

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
