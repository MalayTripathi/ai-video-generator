// Display-only casing for the camera enum values (shot_size/camera_angle/camera_movement).
// Mirrors language-labels.ts's pattern: a Record plus a lookup falling back to the raw
// value. The stored values themselves (src/lib/config/enums.ts, the DB CHECK
// constraints, the write_shots tool schema) are untouched - this only changes what a
// person reads.
const SHOT_SIZE_LABELS: Record<string, string> = {
  wide: 'Wide',
  full: 'Full',
  medium: 'Medium',
  close_up: 'Close up',
  extreme_close_up: 'Extreme close up',
}

const CAMERA_ANGLE_LABELS: Record<string, string> = {
  eye_level: 'Eye level',
  low: 'Low',
  high: 'High',
  over_the_shoulder: 'Over the shoulder',
  top_down: 'Top down',
}

const CAMERA_MOVEMENT_LABELS: Record<string, string> = {
  static: 'Static',
  slow_push_in: 'Slow push in',
  pull_out: 'Pull out',
  pan: 'Pan',
  tilt: 'Tilt',
  orbit: 'Orbit',
  handheld: 'Handheld',
}

export function shotSizeLabel(value: string | null): string {
  if (!value) return '—'
  return SHOT_SIZE_LABELS[value] ?? value
}

export function cameraAngleLabel(value: string | null): string {
  if (!value) return '—'
  return CAMERA_ANGLE_LABELS[value] ?? value
}

export function cameraMovementLabel(value: string | null): string {
  if (!value) return '—'
  return CAMERA_MOVEMENT_LABELS[value] ?? value
}
