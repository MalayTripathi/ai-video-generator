import type Anthropic from '@anthropic-ai/sdk'
import type { ClaudeGateway } from '../../src/lib/claude'

type FakeResult = { message: Anthropic.Message; stopReason: string | null; requestId: string | null }

/** A complete tool_use turn - the real gateway's success stop_reason. Defaults to
 * write_shots; pass toolName for a different tool (e.g. write_prompts). */
export function successMessage(input: unknown, toolName = 'write_shots'): FakeResult {
  return {
    message: {
      content: [{ type: 'tool_use', id: 'tu_test', name: toolName, input }],
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as Anthropic.Message,
    stopReason: 'tool_use',
    requestId: 'req_test',
  }
}

/** Same shape, but stopped early - exercises the max_tokens truncation branch. */
export function truncatedMessage(input: unknown, toolName = 'write_shots'): FakeResult {
  return { ...successMessage(input, toolName), stopReason: 'max_tokens' }
}

/** A full gateway whose createMessage throws, simulating a hard API/network failure.
 * Pass an Error instance (e.g. LiveCallsBlockedError) to throw it directly rather than
 * wrapping a message in a plain Error. */
export function throwingGateway(error: Error | string = 'simulated Claude failure'): ClaudeGateway {
  return {
    async createMessage() {
      throw typeof error === 'string' ? new Error(error) : error
    },
  }
}
