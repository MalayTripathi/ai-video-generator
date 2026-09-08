// A shot needs SOME spoken content, not necessarily narration - see
// shot-generation.ts's own system-prompt comment: "voice_over: ... can be empty only
// if the shot carries character dialogue instead." Shared by the client field
// (voiceover-field.tsx), the server action (workbench/actions.ts), and the agent tool
// (agent/tools.ts) so the rule and its message live in exactly one place.
export const EMPTY_VOICEOVER_MESSAGE =
  "A shot needs narration or a dialogue line — otherwise it plays silent. Add one, or ask the agent to write it."

export function voiceOverIsValid(trimmedVoiceOver: string, hasDialogue: boolean): boolean {
  return trimmedVoiceOver !== '' || hasDialogue
}
