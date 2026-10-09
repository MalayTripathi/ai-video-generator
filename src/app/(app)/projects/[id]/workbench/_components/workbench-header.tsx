'use client'

import { ProjectHeader } from '@/components/workbench/project-header'
import { useShots } from './shots-context'

export function WorkbenchHeader({
  project,
}: {
  project: {
    id: string
    title: string | null
    source_text: string | null
    video_type: string | null
    aspect_ratio: string | null
    language: string | null
    video_model: string | null
    video_resolution: string
    image_quality: string
    image_model: string
    quality_preset: string
    duration_target: string | null
    furthest_step: number
  }
}) {
  const { shots, videoType } = useShots()
  return <ProjectHeader project={{ ...project, video_type: videoType }} shots={shots} />
}
