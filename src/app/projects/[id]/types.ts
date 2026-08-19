export type ProjectStatus = 'draft' | 'in_progress' | 'completed' | 'failed'
export type WizardStep = 'script' | 'voiceover' | 'images' | 'video'

export type Project = {
  id: string
  title: string
  status: ProjectStatus
  current_step: WizardStep
  created_at: string
}

export type Scene = {
  id: string
  position: number
  scene_key: string
  voice_over: string
  image_prompt: string | null
  video_prompt: string | null
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}
