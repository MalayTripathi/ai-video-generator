'use client'

import { ProjectHeader } from '@/components/workbench/project-header'
import { useShots } from './shots-context'

export function WorkbenchHeader({
  project,
}: {
  project: {
    title: string | null
    source_text: string | null
    video_type: string | null
    aspect_ratio: string | null
    language: string | null
    video_model: string | null
    duration_target: string | null
  }
}) {
  const { shots, videoType } = useShots()
  return <ProjectHeader project={{ ...project, video_type: videoType }} shots={shots} />
}
