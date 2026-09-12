import type Anthropic from '@anthropic-ai/sdk'
import type { ClaudeGateway } from '../../src/lib/claude'

type FakeResult = { message: Anthropic.Message; stopReason: string | null; requestId: string | null }

type FakeUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

const DEFAULT_USAGE: FakeUsage = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** A complete tool_use turn - the real gateway's success stop_reason. Defaults to
 * write_shots; pass toolName for a different tool (e.g. write_image_prompts). Every
 * builder here defaults to a fixed 10/10 usage shape; pass `usage` to control the
 * settled dollar cost precisely (e.g. a credit-ledger test pinning an exact charge). */
export function successMessage(input: unknown, toolName = 'write_shots', usage: FakeUsage = DEFAULT_USAGE): FakeResult {
  return {
    message: {
      content: [{ type: 'tool_use', id: 'tu_test', name: toolName, input }],
      usage,
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

/** A text-only end_turn reply - no tool_use block. Every existing fake builds a
 * tool_use turn; this is what a loop's final, non-tool-calling response looks like. */
export function textMessage(text: string, usage: FakeUsage = DEFAULT_USAGE): FakeResult {
  return {
    message: {
      content: [{ type: 'text', text, citations: null }],
      usage,
    } as unknown as Anthropic.Message,
    stopReason: 'end_turn',
    requestId: 'req_test',
  }
}

/** A single response carrying multiple tool_use blocks - the shape a model uses to
 * bundle several actions (e.g. a decline plus a mutation) into one reply instead of
 * waiting for a result before calling the next one. */
export function multiToolMessage(calls: { name: string; input: unknown }[]): FakeResult {
  return {
    message: {
      content: calls.map((call, i) => ({ type: 'tool_use', id: `tu_test_${i}`, name: call.name, input: call.input })),
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as Anthropic.Message,
    stopReason: 'tool_use',
    requestId: 'req_test',
  }
}

/** A single response carrying a text block AND one or more tool_use blocks - the shape a
 * model uses when it narrates before acting (e.g. "Let me check that shot first" before a
 * get_shot call), as opposed to multiToolMessage's tool-use-only bundling. */
export function mixedMessage(text: string, calls: { name: string; input: unknown }[]): FakeResult {
  return {
    message: {
      content: [
        { type: 'text', text, citations: null },
        ...calls.map((call, i) => ({ type: 'tool_use', id: `tu_test_${i}`, name: call.name, input: call.input })),
      ],
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as Anthropic.Message,
    stopReason: 'tool_use',
    requestId: 'req_test',
  }
}

/** A gateway that pops one scripted result per call, in order, and optionally fires
 * onTextDelta for each string in that result's `deltas` before resolving - the seam a
 * multi-iteration agent-turn test needs, since every other fake here answers only once.
 * Throws loudly if called more times than scripted (a test bug, not a real failure).
 * Records each call's own params (getCalls) so a test can assert on exactly what
 * conversation history/messages were actually sent, not just how many times. */
export function scriptedGateway(results: (FakeResult & { deltas?: string[] })[]): ClaudeGateway & {
  getCallCount: () => number
  getCalls: () => Anthropic.MessageCreateParams[]
} {
  let callIndex = 0
  const calls: Anthropic.MessageCreateParams[] = []
  return {
    async createMessage(params, hooks) {
      if (callIndex >= results.length) {
        throw new Error(`scriptedGateway called ${callIndex + 1} times but only ${results.length} were scripted`)
      }
      calls.push(params)
      const { deltas, ...result } = results[callIndex]
      callIndex++
      for (const delta of deltas ?? []) {
        hooks?.onTextDelta?.(delta)
      }
      return result
    },
    getCallCount: () => callIndex,
    getCalls: () => calls,
  }
}
