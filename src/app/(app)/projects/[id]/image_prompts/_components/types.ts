import type { DisplayElement } from '../../workbench/_components/types'

export type PromptShot = {
  id: string
  order_index: number
  shot_key: string
  image_prompt: string | null
  image_prompt_stale: boolean
  image_prompt_edited: boolean
  /** The shot's Storyboard frame (thumbnail, or the full image), display only; null when none. */
  frame: { url: string; stale: boolean } | null
  elements: DisplayElement[]
}
