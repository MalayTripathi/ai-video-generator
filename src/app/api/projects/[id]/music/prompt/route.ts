import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClaudeGateway } from '@/lib/claude'
import { runMusicPromptDerivation } from '../logic'

export const runtime = 'nodejs'
// Must stay a literal; mirrors MUSIC_PROMPT_ROUTE_MAX_DURATION_S (src/lib/config/storyboard.ts).
export const maxDuration = 60

// Derive the music style prompt - once per project (the claim guards it), free to the
// user. The card calls this only on its first expand while the field is empty.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await runMusicPromptDerivation({ supabase, gateway: createClaudeGateway(), projectId, userId: user.id })
  const { ok, status, ...rest } = result
  return NextResponse.json({ ok, ...rest }, { status })
}
