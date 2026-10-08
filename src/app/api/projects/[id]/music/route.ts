import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tryLoadRailFigures } from '@/app/(app)/rail-figures'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { createMusicGateway } from '@/lib/music/gateway'
import { mintAttemptId, recordFixedSpend } from '@/lib/credits/ledger'
import { getBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { runMusicRequest, runMusicWorker } from './logic'
import { refusalResponse } from '../voiceover/respond'

export const runtime = 'nodejs'
// The music is composed in the background inside this invocation (after()). Must stay a
// literal (Vercel Hobby's 300s ceiling); mirrors MUSIC_ROUTE_MAX_DURATION_S
// (src/lib/config/storyboard.ts), which MUSIC_STALE_AFTER_MS sits just past.
export const maxDuration = 300

// Generate the project's music: price from the picture's length, gate (402 before any
// claim), claim, then compose in the background. The page learns the outcome from the
// status poll. Charged on success only.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  let body: { expectedCredits?: unknown } | null
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body?.expectedCredits !== 'number') {
    return NextResponse.json({ ok: false, error: 'expectedCredits is required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await runMusicRequest({
    supabase,
    projectId,
    userId: user.id,
    expectedCredits: body.expectedCredits,
    getBalance,
    ensureSignupGrant,
    mintAttemptId,
  })
  if (!result.ok) return refusalResponse(result)

  const userId = user.id
  after(async () => {
    await runMusicWorker(
      { supabase: createServiceRoleClient(), gateway: createMusicGateway(), recordFixedSpend },
      { userId, projectId, generationId: result.generationId }
    )
  })

  const rail = await tryLoadRailFigures(user.id)
  return NextResponse.json({ ok: true, credits: result.credits, rail }, { status: 202 })
}
