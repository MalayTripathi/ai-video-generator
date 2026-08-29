export type DisplayElement = {
  id: string
  name: string
  type: string
  status: string
  reference_image_path: string | null
}

export type DisplayDialogueLine = { element_id: string; element_name: string; line: string }

export type DisplayShot = {
  id: string
  order_index: number
  shot_key: string
  section_label: string | null
  voice_over: string
  visual_description: string | null
  duration_sec: number | null
  duration_locked: boolean
  elements: DisplayElement[]
  dialogue: DisplayDialogueLine[]
}
