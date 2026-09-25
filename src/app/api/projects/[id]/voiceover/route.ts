import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tryLoadRailFigures } from '@/app/(app)/rail-figures'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { createVoiceoverGateway } from '@/lib/voiceover/gateway'
import { mintAttemptId, recordFixedSpend } from '@/lib/credits/ledger'
import { getBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { runVoiceoverRequest, runVoiceoverWorker } from './logic'
import { refusalResponse } from './respond'

export const runtime = 'nodejs'
// The read runs in the background inside this invocation (after()), every chunk of it.
// Must stay a literal here; mirrors VOICEOVER_ROUTE_MAX_DURATION_S in
// src/lib/config/storyboard.ts, which VOICEOVER_STALE_AFTER_MS fits inside.
export const maxDuration = 800

// Generate the project's voiceover: validate, price, gate (402 before any claim), claim,
// then read in the background. The page learns the outcome from the status poll.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  let body: { voiceId?: unknown; expectedCredits?: unknown } | null
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const voiceId = body?.voiceId
  const expectedCredits = body?.expectedCredits
  if (typeof voiceId !== 'string' || voiceId === '' || typeof expectedCredits !== 'number') {
    return NextResponse.json({ ok: false, error: 'voiceId and expectedCredits are required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await runVoiceoverRequest({
    supabase,
    projectId,
    userId: user.id,
    voiceId,
    expectedCredits,
    getBalance,
    ensureSignupGrant,
    mintAttemptId,
  })
  if (!result.ok) return refusalResponse(result)

  const userId = user.id
  after(async () => {
    await runVoiceoverWorker(
      { supabase: createServiceRoleClient(), gateway: createVoiceoverGateway(), recordFixedSpend },
      { userId, projectId, generationId: result.generationId }
    )
  })

  const rail = await tryLoadRailFigures(user.id)
  return NextResponse.json({ ok: true, credits: result.credits, rail }, { status: 202 })
}
