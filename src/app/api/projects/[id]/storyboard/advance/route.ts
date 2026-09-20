import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { runAdvanceToStoryboard } from './logic'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const result = await runAdvanceToStoryboard({
    supabase,
    projectId,
    userId: user.id,
    getBalance,
    ensureSignupGrant,
  })

  if (result.ok) {
    return NextResponse.json({ ok: true, data: result.data }, { status: result.status })
  }

  if (result.status === 402) {
    return NextResponse.json(
      { ok: false, error: result.error, requiredCredits: result.requiredCredits, balanceCredits: result.balanceCredits },
      { status: 402 }
    )
  }

  return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
}
