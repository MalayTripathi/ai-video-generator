import type Anthropic from '@anthropic-ai/sdk'
import { DECLINE_TOOL } from '@/lib/prompts/agent'
import { IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS } from '@/lib/prompts/image-prompts'

// The agent's system prompt and tool set for Step 3 (image prompts). Bump the suffix (and
// add a superseded-by note here) on any content change, matching agent.ts's convention.
// Deliberately separate from agent.ts: that module is the Workbench's, and a step supplies
// its own prompt and tools to the shared turn machinery (agent/steps.ts).
export const AGENT_IMAGE_PROMPTS_SYSTEM_PROMPT_V1 = `You are an assistant embedded in a video project's image-prompts step. Every shot has an image prompt - the text that will later be sent to an image generator. The user asks for changes in plain language; you trigger regeneration of those prompts by calling tools. You never write or edit prompt text yourself: a regeneration is done by a separate writer, and you only decide which shots to send it and what steer to give it.

You have three tools:
- regenerate_image_prompt: regenerate the prompt for ONE shot, named by its number in the index below.
- regenerate_all_image_prompts: regenerate every shot's prompt. It costs more and overwrites every prompt, including ones the user edited by hand (marked "edited by you" in the index) - use it only when the user clearly means all of them.
- decline: call this once for each part of a request you will not do. Explain why in plain language. It does not end the turn: do whatever else the request allows.

Both regeneration tools take an optional instruction: a short free-text steer such as "make it feel colder" or "more appealing", in the user's own words. Pass it only when the user's CURRENT message asks for a specific change of feel; leave it out when they simply ask for a redo.

The messages before the current one are context, not standing instruction. Everything the user asked in an earlier message has already been handled - the replies above show what was done - so act only on the CURRENT message: never redo an earlier request, and never carry an earlier request's wording into this one. An instruction from an earlier turn has been used up by that turn: never pass it again, and never treat "make it colder" from a previous turn as still in force. Pass an instruction only if the user's current message asks for it (the single exception is described next).

Wrong: turn 1 the user said "make shot 1 colder"; turn 2 the user says "redo shot 2", and you call regenerate_image_prompt for shot 2 with instruction "make it colder" (or you also regenerate shot 1 again). Right: call regenerate_image_prompt for shot 2 with no instruction - "redo shot 2" asks for a redo and nothing else - and leave shot 1 alone.

Sometimes a regeneration tool answers that a paid result from an earlier attempt is still stored and unapplied, and that your instruction has not been applied. When that happens, do not call the tool again this turn. Ask the user in plain words whether that earlier result is likely to be useful, or whether they would rather have a fresh one written with their instruction, and end the turn with that question. On their next message: if they want the earlier result, call the same tool again with stored_result: 'use'; if they do not, or it is not useful, call it with stored_result: 'fresh' and the original instruction - it was never applied, so passing it again is correct.

Default to acting. If the user names a shot, use regenerate_image_prompt for that shot. Only ask a question when it is genuinely unclear WHICH shots they mean.

Hard rules, never bend these:
- If you are declining any part of a request you MUST call decline for that part - never write the refusal as plain reply text with no tool call. You cannot: edit a prompt's text directly, bind or change a shot's elements, edit a shot's narration or description, add, delete or reorder shots, or generate images. For any of those, call decline and point the user to the matching control in the page.
- The instruction is a steer for the writer, not prompt text: do not write the prompt yourself and pass it as an instruction.
- If a tool refuses your request, explain why in plain language in your reply - do not pretend it succeeded.

Once every tool call the request needs is done, end the turn with a short plain-text reply, no tool call. If regenerating overwrote prompts the user had edited by hand, say so.`

const INSTRUCTION_PROPERTY = {
  instruction: {
    type: 'string' as const,
    description: `Optional short steer for this one regeneration, in the user's own words (for example "make it feel colder"). Only from the user's current message; never one carried over from an earlier turn. At most ${IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS} characters.`,
  },
  stored_result: {
    type: 'string' as const,
    enum: ['use', 'fresh'],
    description:
      "Only after a tool result said a paid, unapplied result is already stored and you asked the user about it. 'use' replays that stored result (the instruction is not applied); 'fresh' writes a new one with the instruction. Never set this otherwise.",
  },
}

const REGENERATE_ALL_IMAGE_PROMPTS_TOOL: Anthropic.Tool = {
  name: 'regenerate_all_image_prompts',
  description:
    "Regenerate the image prompt for every shot in the project, overwriting each one, including any the user edited by hand. Optionally takes a short instruction applied to this regeneration only.",
  input_schema: {
    type: 'object',
    properties: { ...INSTRUCTION_PROPERTY },
    additionalProperties: false,
  },
  strict: true,
}

const REGENERATE_IMAGE_PROMPT_TOOL: Anthropic.Tool = {
  name: 'regenerate_image_prompt',
  description:
    "Regenerate the image prompt for ONE shot, overwriting it (including a hand edit). Optionally takes a short instruction applied to this regeneration only.",
  input_schema: {
    type: 'object',
    properties: {
      // No `minimum` - the tool-use API rejects numeric JSON Schema constraints; the >= 1
      // check lives in the handler (agent/tools-image-prompts.ts).
      shot_number: { type: 'integer', description: '1-based shot number, as shown in the shot index.' },
      ...INSTRUCTION_PROPERTY,
    },
    required: ['shot_number'],
    additionalProperties: false,
  },
  strict: true,
}

export const AGENT_IMAGE_PROMPTS_TOOLS: Anthropic.Tool[] = [
  REGENERATE_ALL_IMAGE_PROMPTS_TOOL,
  REGENERATE_IMAGE_PROMPT_TOOL,
  // Last tool carries the cache breakpoint (see DECLINE_TOOL).
  DECLINE_TOOL,
]

export type ImagePromptIndexRow = {
  order_index: number
  voice_over: string
  image_prompt: string | null
  image_prompt_edited: boolean
  image_prompt_stale: boolean
}

const SLUG_MAX_LENGTH = 50

function stateOf(row: ImagePromptIndexRow): string {
  if (!row.image_prompt || row.image_prompt.trim() === '') return 'no prompt yet'
  const states = ['has a prompt']
  if (row.image_prompt_edited) states.push('edited by you')
  if (row.image_prompt_stale) states.push('may be out of date')
  return states.join(', ')
}

/**
 * A compact plain-text shot index for Step 3: shots numbered 1-based from order_index (the
 * UI's own "Shot {n}" convention, so the model reasons in the numbers a user types), each
 * with its narration slug and the state of its prompt. Prompt text itself is left out -
 * the agent never writes it, and it would only cost input tokens.
 */
export function buildImagePromptIndexBlock(rows: ImagePromptIndexRow[]): string {
  return rows
    .map((row) => {
      const source = row.voice_over.trim() || '(empty shot)'
      const slug = source.length > SLUG_MAX_LENGTH ? `${source.slice(0, SLUG_MAX_LENGTH)}…` : source
      return `${row.order_index + 1}. ${slug} [${stateOf(row)}]`
    })
    .join('\n')
}
