import Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import { estimateClaudeCostUsd } from '@/lib/config/models'

export interface ClaudeGateway {
  createMessage(params: Anthropic.MessageCreateParams): Promise<{
    message: Anthropic.Message
    stopReason: string | null
    requestId: string | null
  }>
}

/** Best-effort label for the dev-log banner; not used for anything else. */
function describeCall(params: Anthropic.MessageCreateParams): string {
  const toolChoice = params.tool_choice
  if (toolChoice && toolChoice.type === 'tool') return toolChoice.name
  return params.tools?.[0]?.name ?? 'unspecified'
}

function assertLiveCallsAllowed(): void {
  if (process.env.NODE_ENV === 'production') return
  if (process.env.ALLOW_REAL_CLAUDE === '1') return

  throw new Error(
    'Blocked a real, billed Anthropic call: live calls outside production ' +
      'require ALLOW_REAL_CLAUDE=1, and this flag is set by the developer only.'
  )
}

export function createClaudeGateway(): ClaudeGateway {
  return {
    async createMessage(params) {
      assertLiveCallsAllowed()

      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[claude] LIVE call outside production — model=${params.model} kind=${describeCall(params)}`
        )
      }

      // maxRetries: 0 is deliberate - an SDK-level retry on a partially
      // generated response is a silent second charge. Every retry in this
      // app is user-initiated and confirmed. Do not "fix" this later.
      const client = new Anthropic({ maxRetries: 0, timeout: 600_000 })

      // Always streams, even though nothing reads the deltas: a long shot
      // generation can exceed any sane non-streaming timeout.
      const stream = client.messages.stream(params)
      const message = await stream.finalMessage()

      return {
        message,
        stopReason: message.stop_reason,
        requestId: stream.request_id ?? null,
      }
    },
  }
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Logs usage to the console (as before) and persists a best-effort `usage`
 * row for spend tracking. A failed insert is logged, not thrown - usage
 * tracking must never break the caller's request.
 */
export async function logClaudeUsage(
  supabase: SupabaseServerClient,
  projectId: string,
  kind: 'prompts' | 'shots',
  model: string,
  usage: Anthropic.Usage
) {
  console.log(`[${kind}] usage`, {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  })

  const { error } = await supabase.from('usage').insert({
    project_id: projectId,
    provider: 'anthropic',
    kind,
    input_units: usage.input_tokens,
    output_units: usage.output_tokens,
    cache_creation_units: usage.cache_creation_input_tokens ?? 0,
    cache_read_units: usage.cache_read_input_tokens ?? 0,
    estimated_cost: estimateClaudeCostUsd(model, usage),
  })

  if (error) {
    console.error(`[${kind}] failed to persist usage row`, error.message)
  }
}
