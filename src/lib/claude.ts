import Anthropic from '@anthropic-ai/sdk'

export function createClaudeClient() {
  return new Anthropic()
}
