import type Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import { stepIndex, isAgentStep, type AgentStep } from '@/lib/config/pipeline'
import { AGENT_SYSTEM_PROMPT_V11, AGENT_TOOLS, buildShotIndexBlock } from '@/lib/prompts/agent'
import {
  AGENT_IMAGE_PROMPTS_SYSTEM_PROMPT_V1,
  AGENT_IMAGE_PROMPTS_TOOLS,
  buildImagePromptIndexBlock,
} from '@/lib/prompts/agent-image-prompts'
import {
  IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS,
  expectedImagePromptsOutputTokens,
  type ImagePromptsHistoryEntry,
} from '@/lib/prompts/image-prompts'
import { modelsConfig } from '@/lib/config/models'
import { estimateExpectedCallCost } from '@/lib/usage/quote'
import { buildImagePromptsRequest } from '@/app/api/projects/[id]/image-prompts/logic'
import { dispatchAgentTool, type AgentToolContext, type AgentToolOutcome } from './tools'
import { dispatchImagePromptsAgentTool } from './tools-image-prompts'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

// Which cards a tool is about to write to, told to the client BEFORE the paid call so the
// cards can lock for its whole duration (see AgentStreamEvent's tool_started).
export type ToolLockScope = { shotNumber: number } | 'all'

/**
 * What one step supplies to the shared agent turn (logic.ts): its prompt, its tools and how
 * they dispatch, the compact project context the model reads, and how the step locks. The
 * turn machinery - idempotency, the mutex claim, the iteration loop, usage and the single
 * dynamic ledger charge - is the same for every step and lives in runAgentTurn.
 */
export type AgentStepConfig = {
  step: AgentStep
  systemPrompt: string
  tools: Anthropic.Tool[]
  dispatch: (name: string, input: unknown, ctx: AgentToolContext) => Promise<AgentToolOutcome>
  buildContextBlock: (supabase: SupabaseServerClient, projectId: string) => Promise<string>
  // Already the 1-7 index (CLAUDE.md), never a step name.
  isLocked: (furthestStepIndex: number) => boolean
  lockedReply: string
  // Present only for a step whose tools write to cards the person could also be editing:
  // maps a tool call to the cards it is about to write, or null when it writes none.
  // Absent means the step's turns announce no tool starts (the Workbench, which locks a
  // card once its tool completes). Must be a pure read of the tool name and input.
  toolLockScope?: (toolName: string, input: unknown) => ToolLockScope | null
  // Present only for a step whose turn is balance-gated: the estimated USD cost of the most
  // expensive tool call a turn of this step could make, at its EXPECTED size (not its
  // max_tokens ceiling). The turn adds its own estimated agent calls (estimateAgentTurnCost),
  // converts once, and refuses before its claim if the balance falls short. Absent means the
  // step's turns are not gated (the Workbench).
  toolEstimateUsd?: (params: {
    supabase: SupabaseServerClient
    projectId: string
    history: ImagePromptsHistoryEntry[]
  }) => Promise<number>
}

const WORKBENCH_CONFIG: AgentStepConfig = {
  step: 'workbench',
  systemPrompt: AGENT_SYSTEM_PROMPT_V11,
  tools: AGENT_TOOLS,
  dispatch: dispatchAgentTool,
  async buildContextBlock(supabase, projectId) {
    const { data } = await supabase
      .from('shots')
      .select(
        'order_index, visual_description, voice_over, section_label, shot_size_origin, camera_angle_origin, camera_movement_origin'
      )
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
    return buildShotIndexBlock(data ?? [])
  },
  isLocked: (furthestStepIndex) => furthestStepIndex >= stepIndex('storyboard'),
  lockedReply:
    "This project's workbench is locked because later steps have already started, so I can no longer change shots here.",
}

const IMAGE_PROMPTS_CONFIG: AgentStepConfig = {
  step: 'image_prompts',
  systemPrompt: AGENT_IMAGE_PROMPTS_SYSTEM_PROMPT_V1,
  tools: AGENT_IMAGE_PROMPTS_TOOLS,
  dispatch: dispatchImagePromptsAgentTool,
  async buildContextBlock(supabase, projectId) {
    const { data } = await supabase
      .from('shots')
      .select('order_index, voice_over, image_prompt, image_prompt_edited, image_prompt_stale')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
    return buildImagePromptIndexBlock(data ?? [])
  },
  toolLockScope(toolName, input) {
    if (toolName === 'regenerate_all_image_prompts') return 'all'
    if (toolName === 'regenerate_image_prompt') {
      const shotNumber = (input as { shot_number?: unknown } | null)?.shot_number
      return typeof shotNumber === 'number' && Number.isInteger(shotNumber) && shotNumber >= 1 ? { shotNumber } : null
    }
    return null
  },
  isLocked: (furthestStepIndex) => furthestStepIndex >= stepIndex('storyboard'),
  lockedReply:
    "This project's image prompts are locked because the storyboard has already started, so I can no longer change them here.",
  async toolEstimateUsd({ supabase, projectId, history }) {
    const { data } = await supabase
      .from('shots')
      .select('shot_key, voice_over')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
    const shots = (data ?? []).filter((s): s is { shot_key: string; voice_over: string } => s.shot_key !== null)
    // The largest thing a turn can ask for is every shot rewritten, with a maximum-length
    // instruction and the same history the turn carries. The request is built by the same
    // function the real call uses, so the input side cannot drift; the output side is the
    // expected size for that many shots, not the 8192-token ceiling.
    const request = buildImagePromptsRequest({
      allShots: shots,
      targetKeys: shots.map((s) => s.shot_key),
      instruction: 'x'.repeat(IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS),
      history,
    })
    return estimateExpectedCallCost({
      model: modelsConfig.imagePrompts.model,
      estimatedInputTokens: request.estimatedInputTokens,
      expectedOutputTokens: expectedImagePromptsOutputTokens(shots.length),
      maxTokens: modelsConfig.imagePrompts.maxTokens,
    })
  },
}

const CONFIGS: Record<AgentStep, AgentStepConfig> = {
  workbench: WORKBENCH_CONFIG,
  image_prompts: IMAGE_PROMPTS_CONFIG,
}

/**
 * Looks up a step's agent config. Throws on an unknown step rather than falling back to
 * the Workbench's: a silent default would run one step's tools against another step's
 * project. Callers taking a step from a request validate it with isAgentStep first.
 */
export function getAgentStepConfig(step: AgentStep): AgentStepConfig {
  if (!isAgentStep(step)) throw new Error(`No agent config for step "${String(step)}"`)
  return CONFIGS[step]
}
