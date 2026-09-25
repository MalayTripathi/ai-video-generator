import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tryLoadRailFigures } from '@/app/(app)/rail-figures'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { createVoiceoverGateway } from '@/lib/voiceover/gateway'
import { recordFixedSpend } from '@/lib/credits/ledger'
import { getBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { runAlignRequest, runAlignWorker } from '../logic'
import { refusalResponse } from '../respond'

export const runtime = 'nodejs'
// Must stay a literal; mirrors VOICEOVER_ROUTE_MAX_DURATION_S (src/lib/config/storyboard.ts).
export const maxDuration = 800

// Step two of an upload: measure the stored file, price it per minute, gate (402 before
// any claim), claim, then align it to the script in the background. Charged on success
// only; a failed alignment is not charged and keeps the file.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  let body: { attemptId?: unknown; ext?: unknown; expectedCredits?: unknown } | null
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body?.attemptId !== 'string' || typeof body?.ext !== 'string' || typeof body?.expectedCredits !== 'number') {
    return NextResponse.json({ ok: false, error: 'attemptId, ext and expectedCredits are required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await runAlignRequest({
    supabase,
    projectId,
    userId: user.id,
    attemptId: body.attemptId,
    ext: body.ext,
    expectedCredits: body.expectedCredits,
    getBalance,
    ensureSignupGrant,
  })
  if (!result.ok) return refusalResponse(result)

  const userId = user.id
  const audio = result.audio
  after(async () => {
    await runAlignWorker(
      { supabase: createServiceRoleClient(), gateway: createVoiceoverGateway(), recordFixedSpend },
      { userId, projectId, generationId: result.generationId, audio }
    )
  })

  const rail = await tryLoadRailFigures(user.id)
  return NextResponse.json({ ok: true, credits: result.credits, rail }, { status: 202 })
}
