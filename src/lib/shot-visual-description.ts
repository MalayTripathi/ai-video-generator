// A shot's visual description is the sole input to both image and video prompts (both
// paid) and to camera re-derivation (also paid) - an empty value means paying to generate
// an artifact, or asking the model to infer framing, from nothing. Shared by the client
// field (visual-description-field.tsx), the server action (workbench/actions.ts), the
// agent tool (agent/tools.ts), and the camera-derivation guard (camera/logic.ts) so the
// rule and its message live in exactly one place - same shape as shot-voiceover.ts.
export const EMPTY_VISUAL_DESCRIPTION_MESSAGE =
  "A shot needs a visual description — otherwise there's nothing to generate an image or video prompt from. Add one, or ask the agent to write it."

export function visualDescriptionIsValid(trimmedVisualDescription: string): boolean {
  return trimmedVisualDescription !== ''
}
