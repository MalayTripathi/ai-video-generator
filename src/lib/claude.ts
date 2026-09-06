import Anthropic from '@anthropic-ai/sdk'

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

/** Best-effort label for the dev-log banner; not used for anything else. */
function describeCall(params: Anthropic.MessageCreateParams): string {
  const toolChoice = params.tool_choice
  if (toolChoice && toolChoice.type === 'tool') return toolChoice.name
  return params.tools?.[0]?.name ?? 'unspecified'
}

export class LiveCallsBlockedError extends Error {
  constructor() {
    super(
      'Blocked a real, billed Anthropic call: live calls outside production ' +
        'require ALLOW_REAL_CLAUDE=1, and this flag is set by the developer only.'
    )
    this.name = 'LiveCallsBlockedError'
  }
}

export function assertLiveCallsAllowed(): void {
  if (process.env.NODE_ENV === 'production') return
  if (process.env.ALLOW_REAL_CLAUDE === '1') return

  throw new LiveCallsBlockedError()
}

export function createClaudeGateway(): ClaudeGateway {
  return {
    async createMessage(params, hooks) {
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

      // Always streams, even though most callers don't read the deltas: a long shot
      // generation can exceed any sane non-streaming timeout. hooks.onTextDelta, when
      // given, forwards the SDK's own token-by-token 'text' event - additive, every
      // existing caller passes no hooks and is unaffected.
      const stream = client.messages.stream(params)
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
