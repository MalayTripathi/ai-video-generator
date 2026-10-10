import type { Tables } from '@/lib/database.types'

export type {
  CurrentMusic,
  CurrentVoiceover,
  ImageStatusData,
  MusicStatus,
  ShotImageStatus,
  VoiceoverStatus,
} from '@/app/api/projects/[id]/images/status/logic'

// The shot fields the Storyboard page reads. Image state itself is never read off these
// rows - it comes from the status endpoint (the generations claim decides it).
export type StoryboardShot = Pick<
  Tables<'shots'>,
  | 'id'
  | 'shot_key'
  | 'order_index'
  | 'duration_sec'
  | 'duration_locked'
  | 'visual_description'
  | 'image_prompt'
  | 'image_prompt_edited'
  | 'image_prompt_stale'
  | 'image_stale'
  | 'film_order'
  | 'film_duration_sec'
  | 'binned_at'
  | 'voice_over'
  | 'motion'
  | 'split_at'
  | 'split_motion'
  | 'transition_out'
> & { scenes: { title: string } | null }

export const STORYBOARD_SHOT_COLUMNS =
  'id, shot_key, order_index, duration_sec, duration_locked, scenes(title), visual_description, image_prompt, image_prompt_edited, image_prompt_stale, image_stale, film_order, film_duration_sec, binned_at, voice_over, motion, split_at, split_motion, transition_out' as const
