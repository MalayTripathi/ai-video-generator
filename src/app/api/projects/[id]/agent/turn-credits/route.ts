import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Read-only lookup of one agent turn's real credit spend, keyed on the triggering user
// message's id - the same anchor the ledger write itself uses (see logic.ts's
// recordTurnSpend call). RLS-scoped (no service-role): credit_ledger's own SELECT
// policy (user_id = auth.uid()) already fully secures this, so an authenticated client
// is correct and sufficient. Returns `credits: null` when no matching spend row
// exists - either the turn failed (recordTurnSpend only runs when outcome.ok) or it
// cost nothing (recordDynamicSpend writes nothing when usdToCredits rounds to 0) -
// both cases converge here so the client never has to special-case them.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const messageId = new URL(request.url).searchParams.get('messageId')

  if (!messageId) {
    return NextResponse.json({ error: 'messageId is required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const { data: rows } = await supabase
    .from('credit_ledger')
    .select('delta')
    .eq('project_id', projectId)
    .eq('message_id', messageId)
    .eq('kind', 'spend')
    .eq('operation', 'agent_turn')
    .limit(1)

  const credits = rows && rows.length > 0 ? -rows[0].delta : null
  return NextResponse.json({ credits })
}
