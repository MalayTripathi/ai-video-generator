import type { WizardStep } from '@/app/projects/[id]/types'

export type Project = {
  id: string
  title: string
  status: string
  current_step: WizardStep
  created_at: string
}
