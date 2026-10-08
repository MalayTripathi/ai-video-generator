export type Project = {
  id: string
  title: string | null
  source_text: string | null
  status: string
  current_step: string
  created_at: string
  video_type: string | null
  aspect_ratio: string | null
  furthest_step: number
  shot_count: number
}
