import Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import { estimateClaudeCostUsd } from '@/lib/config/models'
import type { Step, Operation } from '@/lib/config/pipeline'

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

export function assertLiveCallsAllowed(): void {
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
 *
 * quantity/unit are Claude-specific for now (input+output tokens);
 * raw_usage.breakdown keeps every provider-reported bucket, including the
 * two cache ones excluded from quantity, so a future rate change can
 * re-derive estimated_cost without re-calling the provider. rate_version
 * is null until models.ts carries a versioned pricing config. status is
 * always 'succeeded' here because this function is only ever called
 * after a successful Claude response.
 */
export async function logClaudeUsage(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  step: Step,
  operation: Operation,
  model: string,
  usage: Anthropic.Usage,
  generationId?: string | null
) {
  console.log(`[${step}:${operation}] usage`, {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  })

  const { error } = await supabase.from('usage').insert({
    user_id: userId,
    project_id: projectId,
    generation_id: generationId ?? null,
    step,
    operation,
    provider: 'anthropic',
    model,
    status: 'succeeded',
    quantity: usage.input_tokens + usage.output_tokens,
    unit: 'tokens',
    raw_usage: {
      breakdown: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    },
    rate_version: null,
    estimated_cost: estimateClaudeCostUsd(model, usage),
  })

  if (error) {
    console.error(`[${step}:${operation}] failed to persist usage row`, error.message)
  }
}
