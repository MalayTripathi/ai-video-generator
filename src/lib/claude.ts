import Anthropic from '@anthropic-ai/sdk'

export function createClaudeClient() {
  return new Anthropic()
}

export function logClaudeUsage(label: string, usage: Anthropic.Usage) {
  console.log(`[${label}] usage`, {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  })
}
