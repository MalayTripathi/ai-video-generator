import type { CameraOrigin } from '@/lib/config/enums'

export type DisplayElement = {
  id: string
  name: string
  type: string
  status: string
  reference_image_path: string | null
}

export type DisplayDialogueLine = {
  id: string
  order_index: number
  element_id: string
  element_name: string
  line: string
}

export type DisplayShot = {
  id: string
  order_index: number
  shot_key: string
  section_label: string | null
  voice_over: string
  visual_description: string | null
  duration_sec: number | null
  duration_locked: boolean
  shot_size: string | null
  shot_size_origin: CameraOrigin
  camera_angle: string | null
  camera_angle_origin: CameraOrigin
  camera_movement: string | null
  camera_movement_origin: CameraOrigin
  elements: DisplayElement[]
  dialogue: DisplayDialogueLine[]
}
