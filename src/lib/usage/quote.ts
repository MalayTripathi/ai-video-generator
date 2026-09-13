import type Anthropic from '@anthropic-ai/sdk'
import { computeCost, OPENAI_RATES, TOOL_USE_SYSTEM_OVERHEAD_TOKENS, type UsageBreakdown } from '@/lib/config/pricing'

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

/**
 * The pre-flight quote for an OpenAI image call. Unlike quoteClaudeCall, the output
 * half is EXACT, not worst-case: OpenAI meters image generation at a fixed
 * output-token count per size/quality tier (OPENAI_RATES.images[model].outputTokensBySize),
 * so there is no "ceiling" to reserve against - the real call can never produce more or
 * fewer output tokens than this. The input half still goes through the same chars/4
 * estimate as every other call (the prompt is short: element name + description +
 * style keywords), since real tokenization still isn't knowable before the call.
 */
export function quoteOpenAiImageCall(params: {
  model: string
  size: string
  quality: string
  estimatedInputTokens: number
}): { estimatedCost: number; quotedBreakdown: UsageBreakdown } {
  const outputTokens = OPENAI_RATES.images[params.model]?.outputTokensBySize[params.size]?.[params.quality] ?? 0

  const quotedBreakdown: UsageBreakdown = {
    input_tokens: params.estimatedInputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  const { estimatedCost } = computeCost('openai', params.model, quotedBreakdown)

  // Same fallback reasoning as quoteClaudeCall: an unrecognized model/size/quality
  // combination (outside OPENAI_RATES) would make estimatedCost null - fall back to 0
  // rather than blocking the call outright.
  return { estimatedCost: estimatedCost ?? 0, quotedBreakdown }
}
