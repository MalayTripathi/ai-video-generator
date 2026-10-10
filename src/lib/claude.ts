import Anthropic from '@anthropic-ai/sdk'
import { assertProviderCallAllowed, guardedFetch, LiveCallsBlockedError } from '@/lib/providers/live-call-guard'
import { isProduction } from '@/lib/config/env'
import { serverEnv } from '@/lib/config/env.server'

export { LiveCallsBlockedError }

export interface ClaudeGatewayHooks {
  /** Forwarded token-by-token as the SDK streams the response, before finalMessage()
   * resolves. Optional and additive - every existing caller passes no second argument. */
  onTextDelta?: (text: string) => void
}

export interface ClaudeGateway {
  createMessage(
    params: Anthropic.MessageCreateParams,
    hooks?: ClaudeGatewayHooks
  ): Promise<{
    message: Anthropic.Message
    stopReason: string | null
    requestId: string | null
  }>
}

/** Best-effort label for the dev-log banner; not used for anything else. A forced
 * tool_choice (every route but the agent) names that tool exactly. With no forced
 * choice, `tools[0]` is a guess about the REQUEST, not the model's eventual pick - the
 * agent route sends its whole unconstrained tool list every iteration, so pinning to
 * index 0 always read "get_shot" no matter which tool actually got called. List every
 * offered tool instead of pretending to know which one wins. */
function describeCall(params: Anthropic.MessageCreateParams): string {
  const toolChoice = params.tool_choice
  if (toolChoice && toolChoice.type === 'tool') return toolChoice.name
  const tools = params.tools ?? []
  if (tools.length === 0) return 'unspecified'
  if (tools.length === 1) return tools[0].name
  return `any of ${tools.length}: ${tools.map((t) => t.name).join(', ')}`
}

// What a person is shown when the model's safety checks decline a request. No provider or
// model name (CLAUDE.md rule 14).
export const REFUSAL_USER_MESSAGE =
  "This request was declined by the AI's safety checks. Nothing was saved and no credits were charged. Try rewording it."

/** A call that ended with stop_reason 'refusal'. Whatever the response carries - even a
 * partial tool_use from a mid-stream decline - is incomplete and must be discarded. */
export class ClaudeRefusalError extends Error {
  readonly category: string | null
  readonly explanation: string | null
  constructor(details: { category: string | null; explanation: string | null } | null) {
    super(REFUSAL_USER_MESSAGE)
    this.name = 'ClaudeRefusalError'
    this.category = details?.category ?? null
    this.explanation = details?.explanation ?? null
  }
}

/** Throws ClaudeRefusalError for a refused call. Call it right after capturing the usage,
 * before reading `content`. Keyed on the stop reason value, never on text. */
export function throwIfRefused(result: { message: Anthropic.Message; stopReason: string | null }): void {
  if (result.stopReason !== 'refusal') return
  const details = result.message.stop_details
  console.warn(`[claude] refusal category=${details?.category ?? 'null'}`)
  throw new ClaudeRefusalError(details ? { category: details.category ?? null, explanation: details.explanation ?? null } : null)
}

export function assertLiveCallsAllowed(): void {
  assertProviderCallAllowed('anthropic')
}

export function createClaudeGateway(): ClaudeGateway {
  return {
    async createMessage(params, hooks) {
      assertLiveCallsAllowed()

      if (!isProduction()) {
        console.warn(
          `[claude] LIVE call on local — model=${params.model} kind=${describeCall(params)}`
        )
      }

      // maxRetries: 0 is deliberate - an SDK-level retry on a partially
      // generated response is a silent second charge. Every retry in this
      // app is user-initiated and confirmed. Do not "fix" this later.
      const client = new Anthropic({ apiKey: serverEnv().providerKeys.anthropic, maxRetries: 0, timeout: 600_000, fetch: guardedFetch('anthropic') })

      // Always streams, even though most callers don't read the deltas: a long shot
      // generation can exceed any sane non-streaming timeout. hooks.onTextDelta, when
      // given, forwards the SDK's own token-by-token 'text' event - additive, every
      // existing caller passes no hooks and is unaffected.
      // A step with no tools (Storyboard's agent) sends an empty list; omit it rather than
      // rely on the API accepting `tools: []`.
      const request = params.tools?.length === 0 ? { ...params, tools: undefined } : params
      const stream = client.messages.stream(request)
      if (hooks?.onTextDelta) {
        stream.on('text', (textDelta) => hooks.onTextDelta!(textDelta))
      }
      const message = await stream.finalMessage()

      return {
        message,
        stopReason: message.stop_reason,
        requestId: stream.request_id ?? null,
      }
    },
  }
}
