import { computeCost, type UsageBreakdown } from '@/lib/config/pricing'

// Crude on purpose: a real tokenizer isn't available at this layer, and this number
// only ever feeds a worst-case reservation that settle immediately corrects downward -
// over-estimating input tokens is safe here in a way it would not be for a bill.
const CHARS_PER_TOKEN_ESTIMATE = 4

/**
 * Estimates input tokens from the character length of the text that will make up the
 * bulk of a Claude call's input (the system prompt blocks). Deliberately excludes the
 * tool schema JSON sent alongside them - a real gap, accepted because a fixed tool
 * schema's token cost is small and stable relative to max_tokens, and because this
 * feeds a worst-case ceiling, not a bill.
 */
export function estimateInputTokens(texts: string[]): number {
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0)
  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)
}

/**
 * The pre-flight quote for a Claude call: estimated input tokens at the input rate,
 * plus the full max_tokens ceiling at the output rate. This is deliberately the worst
 * case - a reservation built from it can never be overrun by the real call, so
 * concurrent in-flight calls can never jointly exceed a spend cap between them. Settle
 * corrects the number downward moments later once the real usage is known.
 */
export function quoteClaudeCall(params: {
  model: string
  estimatedInputTokens: number
  maxTokens: number
}): { estimatedCost: number; quotedBreakdown: UsageBreakdown } {
  const quotedBreakdown: UsageBreakdown = {
    input_tokens: params.estimatedInputTokens,
    output_tokens: params.maxTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  const { estimatedCost } = computeCost('anthropic', params.model, quotedBreakdown)

  // An Anthropic model with no configured rate would make estimatedCost null - but
  // every model reachable through modelsConfig has a CLAUDE_RATES entry (see
  // pricing.ts), so this can only happen for a genuinely unrecognized model string.
  // Falling back to 0 rather than throwing keeps a rate-table gap from blocking every
  // call outright; it under-quotes only in that narrow, easily-noticed case.
  return { estimatedCost: estimatedCost ?? 0, quotedBreakdown }
}
