import type { Tables } from '@/lib/database.types'
import type { CameraOrigin } from '@/lib/config/enums'
import type { DisplayDialogueLine, DisplayShot } from './types'

// One shot row as the Workbench's cards show it - shared by the page's first render and the
// shot-list read a finished run refreshes from, so the two can never disagree. Pure.

export type DisplayElementRow = Pick<Tables<'elements'>, 'id' | 'name' | 'type' | 'status' | 'reference_image_path'>

// Only the columns the shot cards render - the full row also carries image, film and
// video fields this step never reads.
export const WORKBENCH_SHOT_COLUMNS =
  'id, order_index, shot_key, voice_over, visual_description, duration_sec, duration_locked, shot_size, shot_size_origin, camera_angle, camera_angle_origin, camera_movement, camera_movement_origin, scenes(title), shot_elements(elements(id, name, type, status, reference_image_path))'

export type WorkbenchShotRow = Pick<
  Tables<'shots'>,
  | 'id'
  | 'order_index'
  | 'shot_key'
  | 'voice_over'
  | 'visual_description'
  | 'duration_sec'
  | 'duration_locked'
  | 'shot_size'
  | 'shot_size_origin'
  | 'camera_angle'
  | 'camera_angle_origin'
  | 'camera_movement'
  | 'camera_movement_origin'
> & { scenes: { title: string } | null; shot_elements: { elements: DisplayElementRow | null }[] }

export function toDisplayShot(row: WorkbenchShotRow, dialogue: DisplayDialogueLine[]): DisplayShot {
  return {
    id: row.id,
    order_index: row.order_index,
    shot_key: row.shot_key,
    scene_title: row.scenes?.title ?? null,
    voice_over: row.voice_over,
    visual_description: row.visual_description,
    duration_sec: row.duration_sec,
    duration_locked: row.duration_locked,
    shot_size: row.shot_size,
    shot_size_origin: row.shot_size_origin as CameraOrigin,
    camera_angle: row.camera_angle,
    camera_angle_origin: row.camera_angle_origin as CameraOrigin,
    camera_movement: row.camera_movement,
    camera_movement_origin: row.camera_movement_origin as CameraOrigin,
    elements: (row.shot_elements ?? [])
      .map((se) => se.elements)
      .filter((el): el is DisplayElementRow => el !== null)
      .map((el) => ({
        id: el.id,
        name: el.name,
        type: el.type,
        status: el.status,
        reference_image_path: el.reference_image_path,
      })),
    dialogue,
  }
}
