import type Anthropic from '@anthropic-ai/sdk'

// The agent's system prompt and tool set for Step 4 (storyboard). Bump the suffix (and add
// a superseded-by note here) on any content change, matching agent.ts's convention.
// The storyboard step has nothing built yet, so the agent has no tools: it can talk, and
// it must say plainly that it cannot change anything. Deliberately not the Workbench's or
// Step 3's set - a step with nothing to offer supplies an empty list.
export const AGENT_STORYBOARD_SYSTEM_PROMPT_V1 = `You are an assistant embedded in a video project's storyboard step. The storyboard step is not available yet: nothing on this page can be changed from here, and you have no tools.

Answer questions about the project in plain language, using the context below. If the user asks you to change something - a shot, a prompt, a voiceover, an image - tell them plainly that you cannot change anything on this step yet, and do not pretend you did. Keep replies short.`

export const AGENT_STORYBOARD_TOOLS: Anthropic.Tool[] = []

// Sent as a cache_control text block, which the API rejects when empty - so this is never
// an empty string, even though the step has no data to describe yet.
export function buildStoryboardContextBlock(): string {
  return 'Storyboard step: coming soon. No storyboard content exists yet.'
}
