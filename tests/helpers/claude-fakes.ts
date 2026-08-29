import type Anthropic from '@anthropic-ai/sdk'
import type { ClaudeGateway } from '../../src/lib/claude'

type FakeResult = { message: Anthropic.Message; stopReason: string | null; requestId: string | null }

/** A complete write_shots tool_use turn - the real gateway's success stop_reason. */
export function successMessage(input: unknown): FakeResult {
  return {
    message: {
      content: [{ type: 'tool_use', id: 'tu_test', name: 'write_shots', input }],
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as Anthropic.Message,
    stopReason: 'tool_use',
    requestId: 'req_test',
  }
}

/** Same shape, but stopped early - exercises the max_tokens truncation branch. */
export function truncatedMessage(input: unknown): FakeResult {
  return { ...successMessage(input), stopReason: 'max_tokens' }
}

/** A full gateway whose createMessage throws, simulating a hard API/network failure. */
export function throwingGateway(message = 'simulated Claude failure'): ClaudeGateway {
  return {
    async createMessage() {
      throw new Error(message)
    },
  }
}
