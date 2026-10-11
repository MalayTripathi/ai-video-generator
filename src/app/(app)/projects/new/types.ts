export type TemplateProject = {
  id: string
  title: string | null
  source_text: string | null
  video_type: string | null
  aspect_ratio: string | null
  duration_target: string | null
  language: string | null
  quality_preset: string
  video_model: string | null
  video_resolution: string
  image_quality: string
  image_model: string
  created_at: string
}

/** What a refused submit hands back: writing the shot list needs more credits than the user has. */
export type IntakeState = { shortfall: { requiredCredits: number; balanceCredits: number } } | null
