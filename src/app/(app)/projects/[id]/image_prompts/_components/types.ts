import type { DisplayElement } from '../../workbench/_components/types'

export type PromptShot = {
  id: string
  order_index: number
  shot_key: string
  image_prompt: string | null
  image_prompt_stale: boolean
  image_prompt_edited: boolean
  elements: DisplayElement[]
}
