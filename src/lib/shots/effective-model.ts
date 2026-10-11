import { isRegisteredVideoModel, VIDEO_MODELS, type VideoModelConfig } from '@/lib/config/models'

// The video model a shot is rendered with - the one its every length must fit. Today that
// is always the project's model; a per-shot override (Step 5) changes only this function,
// and every duration path (generation, the stepper, the agent, the Storyboard, a model
// change) already asks it per shot.

/** The model this shot's lengths must fit, or null when the project's isn't registered. */
export function effectiveVideoModel(
  project: { video_model: string | null },
  // The shot whose model this is - unread until shots can carry their own.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _shot?: { id: string }
): VideoModelConfig | null {
  return isRegisteredVideoModel(project.video_model) ? VIDEO_MODELS[project.video_model] : null
}
