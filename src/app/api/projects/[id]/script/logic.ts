import type Anthropic from '@anthropic-ai/sdk'

export type ClaudeGateway = {
  createMessage: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>
}

export type MessagesGateway = {
  deleteMessage: (id: string) => Promise<{ error: string | null }>
}

export type ClaudeCallResult =
  | { ok: true; response: Anthropic.Message }
  | { ok: false; error: string }

const CLAUDE_FAILURE_MESSAGE = 'Failed to generate a response. Try again.'

/**
 * Calls Claude for an already-persisted user message. If the call throws,
 * or resolves with no content blocks at all, deletes the orphaned user
 * message row before reporting failure, so a failed turn never lingers in
 * history with no assistant reply.
 */
export async function callClaudeOrCleanup(
  claude: ClaudeGateway,
  messages: MessagesGateway,
  insertedMessageId: string,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<ClaudeCallResult> {
  let response: Anthropic.Message
  try {
    response = await claude.createMessage(params)
  } catch {
    await messages.deleteMessage(insertedMessageId)
    return { ok: false, error: CLAUDE_FAILURE_MESSAGE }
  }

  if (response.content.length === 0) {
    await messages.deleteMessage(insertedMessageId)
    return { ok: false, error: CLAUDE_FAILURE_MESSAGE }
  }

  return { ok: true, response }
}
