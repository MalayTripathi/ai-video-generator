import { TOOL_NAMES, type ToolName } from '@/lib/config/messages'

const VERBS: Record<ToolName, string> = {
  get_shot: 'Looked at',
  update_shot: 'Updated',
  insert_shot: 'Inserted',
  regenerate_all_shots: 'Regenerated all shots', // never carries a shotKey
  regenerate_all_image_prompts: 'Rewrote all image prompts', // never carries a shotKey
  regenerate_image_prompt: 'Rewrote',
}

/**
 * The single place a tool_done row's display text is produced, for both a live turn
 * (agent-panel.tsx) and a reload (build-agent-messages.ts) - both must re-derive it the
 * same way. shotNumber is the CURRENT order_index+1, resolved live from the shots list at
 * render time - never a value stored at write time, which would go stale the moment a
 * later insert/delete renumbers shots. null means the key didn't resolve to a live shot:
 * either it was deleted since, or (insert_shot only, live turn) the brand-new shot hasn't
 * reached this client's shots array yet - a refresh fixes that on its own, so insert_shot
 * gets its own non-alarming fallback rather than "deleted". `fallback` is only used for a
 * toolName this function doesn't recognize (shouldn't happen for a row this feature
 * wrote, but a defensive default beats rendering nothing).
 */
export function describeToolActivity(toolName: string, shotNumber: number | null, fallback: string): string {
  if (toolName === 'regenerate_all_shots') return VERBS.regenerate_all_shots
  if (toolName === 'regenerate_all_image_prompts') return VERBS.regenerate_all_image_prompts
  if (toolName === 'regenerate_image_prompt') {
    return shotNumber !== null ? `Rewrote Shot ${shotNumber} prompt` : "Rewrote a prompt for a shot that's since been deleted"
  }
  const verb = (TOOL_NAMES as readonly string[]).includes(toolName) ? VERBS[toolName as ToolName] : null
  if (!verb) return fallback
  if (shotNumber !== null) return `${verb} Shot ${shotNumber}`
  return toolName === 'insert_shot' ? 'Inserted a new shot' : `${verb} a shot that's since been deleted`
}
