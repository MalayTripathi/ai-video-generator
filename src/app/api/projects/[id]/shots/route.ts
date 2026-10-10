import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { mintAttemptId } from '@/lib/credits/ledger'
import { getBalance } from '@/lib/credits/balance'
import { ensureSignupGrant } from '@/lib/credits/signup-grant'
import { continuationSecretMatches } from '@/lib/continuation'
import { runShotsRequest } from './logic'
import { SHOT_RUN_LEDGER, scheduleShotsWorker } from './schedule'
import { SHOTS_INTERNAL_SECRET_HEADER, acceptShotsContinuation, parseShotsContinuationPayload } from './worker'

// The background run lives inside this invocation (after()), so it gets the route's full
// duration. Must stay a literal here (Vercel Hobby's 300s ceiling); mirrors
// SHOTS_ROUTE_MAX_DURATION_S in src/lib/config/shots.ts, whose SHOT_RUN_BUDGET_MS is sized
// to fit inside it.
export const maxDuration = 300

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const origin = new URL(request.url).origin

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null // no body (the plain auto-trigger POST) throws SyntaxError - expected
  }

  // Continuation path. Only a request presenting the header is considered for it; a wrong
  // or unconfigured secret is refused outright, never downgraded to the user path.
  const providedSecret = request.headers.get(SHOTS_INTERNAL_SECRET_HEADER)
  if (providedSecret !== null) {
    if (!continuationSecretMatches(providedSecret)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const payload = parseShotsContinuationPayload(body, projectId)
    if (!payload) return NextResponse.json({ ok: false, error: 'Invalid continuation' }, { status: 400 })
    const accepted = await acceptShotsContinuation(createServiceRoleClient(), payload)
    if (!accepted.ok) return NextResponse.json({ ok: false, error: accepted.error }, { status: accepted.status })
    scheduleShotsWorker(origin, payload)
    return NextResponse.json({ ok: true }, { status: 202 })
  }

  // User path.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const flags = (body ?? {}) as { retry?: unknown; remaining?: unknown }
  const result = await runShotsRequest({
    supabase,
    projectId,
    userId: user.id,
    mode: flags.remaining === true ? 'remaining' : 'generate',
    retry: flags.retry === true,
    attemptId: mintAttemptId(),
    getBalance,
    ensureSignupGrant,
    ledger: SHOT_RUN_LEDGER,
  })

  if (!result.ok) {
    if (result.status === 402) {
      return NextResponse.json(
        { error: result.error, requiredCredits: result.requiredCredits, balanceCredits: result.balanceCredits },
        { status: 402 }
      )
    }
    return NextResponse.json('reason' in result ? { error: result.error, reason: result.reason } : { error: result.error }, {
      status: result.status,
    })
  }

  scheduleShotsWorker(origin, { userId: user.id, projectId, runId: result.runId, chainDepth: 0 })
  return NextResponse.json({ ok: true, runId: result.runId }, { status: 202 })
}
