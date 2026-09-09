// Single source for which downstream *_stale flags a shot-field edit sets. See
// CLAUDE.md's staleness table. Keyed on which field changed, never on who changed it -
// an agent write and a keystroke produce identical flags. Deliberately does not decide
// whether an edit is a no-op: each call site keeps its own diff-before-write check
// (comparing against the persisted value) and only calls this once it has already
// decided a real change occurred.

export type ShotFieldChange = 'voice_over' | 'visual_description' | 'camera' | 'dialogue' | 'duration'

export interface StalenessUpdate {
  shot: Partial<Record<'image_prompt_stale' | 'video_prompt_stale', true>>
  project: Partial<Record<'voiceover_stale', true>>
}

export function stalenessFor(change: ShotFieldChange): StalenessUpdate {
  switch (change) {
    case 'voice_over':
      // One continuous narration file per project, so any narration edit invalidates
      // the whole render, plus this shot's own two prompt flags.
      return { shot: { image_prompt_stale: true, video_prompt_stale: true }, project: { voiceover_stale: true } }
    case 'visual_description':
    case 'camera':
      // A camera field (dropdown or AI re-derivation) is exactly as visually
      // invalidating as a description edit - both feed the same two prompts.
      return { shot: { image_prompt_stale: true, video_prompt_stale: true }, project: {} }
    case 'dialogue':
      // On-camera speech, not narration - never touches the voiceover.
      return { shot: { video_prompt_stale: true }, project: {} }
    case 'duration':
      // Audio derives from narration text, not duration; a locked-duration mismatch is
      // resolved for free at Step 4 by retiming.
      return { shot: {}, project: {} }
  }
}
