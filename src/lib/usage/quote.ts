import type Anthropic from '@anthropic-ai/sdk'
import { computeCost, TOOL_USE_SYSTEM_OVERHEAD_TOKENS, type UsageBreakdown } from '@/lib/config/pricing'

// Crude on purpose: a real tokenizer isn't available at this layer, and this number
// only ever feeds a worst-case reservation that settle immediately corrects downward -
// over-estimating input tokens is safe here in a way it would not be for a bill.
const CHARS_PER_TOKEN_ESTIMATE = 4

/**
 * Estimates input tokens from everything actually sent to the model: the system
 * prompt text, the user message text, and the serialised tool schema JSON - derived
 * from the same `tools` array passed to the gateway call, so this can never drift out
 * of sync with the schema as it grows (never hardcode a schema size here). Anthropic's
 * fixed tool-use system overhead is added on top as TOOL_USE_SYSTEM_OVERHEAD_TOKENS
 * (pricing.ts), since it isn't proportional to any text sent and so doesn't belong in
 * the char count.
 *
 * Known remaining bias: JSON is punctuation-dense and likely tokenises at fewer than 4
 * chars/token, so the schema portion of this estimate may still run a little low even
 * after this change - worth checking once there are more measured data points (see
 * CLAUDE.md).
 */
export function estimateInputTokens(params: { texts: string[]; tools: Anthropic.Tool[] }): number {
  const textChars = params.texts.reduce((sum, text) => sum + text.length, 0)
  const toolsChars = JSON.stringify(params.tools).length
  const charEstimate = Math.ceil((textChars + toolsChars) / CHARS_PER_TOKEN_ESTIMATE)
  return charEstimate + (params.tools.length > 0 ? TOOL_USE_SYSTEM_OVERHEAD_TOKENS : 0)
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
