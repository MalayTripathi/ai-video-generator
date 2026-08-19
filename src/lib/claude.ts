import Anthropic from '@anthropic-ai/sdk'
import type { createClient } from '@/lib/supabase/server'
import { estimateClaudeCostUsd } from '@/lib/config/models'

export function createClaudeClient() {
  return new Anthropic()
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Logs usage to the console (as before) and persists a best-effort `usage`
 * row for spend tracking. A failed insert is logged, not thrown - usage
 * tracking must never break the caller's request.
 */
export async function logClaudeUsage(
  supabase: SupabaseServerClient,
  projectId: string,
  kind: 'script' | 'prompts',
  model: string,
  usage: Anthropic.Usage
) {
  console.log(`[${kind}] usage`, {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  })

  const { error } = await supabase.from('usage').insert({
    project_id: projectId,
    provider: 'anthropic',
    kind,
    input_units: usage.input_tokens,
    output_units: usage.output_tokens,
    cache_creation_units: usage.cache_creation_input_tokens ?? 0,
    cache_read_units: usage.cache_read_input_tokens ?? 0,
    estimated_cost: estimateClaudeCostUsd(model, usage),
  })

  if (error) {
    console.error(`[${kind}] failed to persist usage row`, error.message)
  }
}
